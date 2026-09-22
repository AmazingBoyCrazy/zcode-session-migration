/**
 * ZCode → DSH v3 session event mapping.
 *
 * Mapping rules (verified against DSH's session semantics):
 *   - one ZCode user message opens one DSH `turn`;
 *   - one ZCode assistant message is exactly one DSH `step` (ZCode never splits one
 *     message across steps);
 *   - the user message lives inside the turn's first step, which is where DSH itself
 *     materializes an inbox prompt;
 *   - `reasoning` / `text` parts become embedded assistant content blocks in part
 *     order; each `tool` part additionally contributes a `tool/call` and a
 *     `tool/result` surface pair sourced from that call's seq;
 *   - the session title is logged with `source.kind: 'user'` and an empty citation
 *     list, which is the only durable way to pin a title against later LLM
 *     regeneration (a non-`user` source must cite an earlier user message instead).
 */
import { randomUUID } from 'node:crypto';
import { SESSION_FORMAT_VERSION } from './dsh-format.mjs';

const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result']);
const PLACEHOLDER_USER_TEXT = '(this message carried only attachments or empty content in ZCode)';

/** Builder that keeps `seq` dense from zero and `time` monotonic. */
class EventBuilder {
  constructor(createdAt) {
    this.events = [];
    this.lastTime = createdAt;
  }

  push(type, data, time, surface = false) {
    const safeTime = Number.isSafeInteger(time) && time > 0 ? time : this.lastTime;
    this.lastTime = Math.max(this.lastTime, safeTime);
    const event = { type, seq: this.events.length, time: this.lastTime, data };
    if (surface || SURFACE_TYPES.has(type)) event.surfaceOp = 'append';
    this.events.push(event);
    return event.seq;
  }
}

function ms(value, fallback) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  return fallback;
}

/** Render one ZCode `file` part as an inert text marker (artifacts are not in the DB). */
function fileMarker(part) {
  const kind = typeof part.mime === 'string' ? part.mime : 'unknown';
  const bytes = part.metadata?.sizeBytes;
  const size = typeof bytes === 'number' ? `, ${bytes} bytes` : '';
  const uri = typeof part.url === 'string' ? `, ${part.url}` : '';
  return `[attachment ${kind}${size}${uri}]`;
}

/** Best-effort textual rendering of a tool result payload. */
function toolResultText(state) {
  const value = state?.output ?? state?.error;
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Convert one ZCode session into a DSH v3 artifact.
 * @param {{session: object, messages: object[], includeToolOutput: boolean}} input
 * @returns {{header: object, events: object[], stats: object}}
 */
export function convertSession({ session, messages, includeToolOutput = true }) {
  const createdAt = ms(session.timeCreated, Date.now());
  const builder = new EventBuilder(createdAt);
  const stats = {
    turns: 0,
    steps: 0,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolErrors: 0,
    skippedParts: 0,
    fileParts: 0,
  };

  // Opening state, matching what a fresh DSH session records before its first turn.
  builder.push('permission/preset', { preset: 'workspace-write' }, createdAt);
  builder.push('sandbox/mode', { mode: 'workspace-write' }, createdAt);
  builder.push('approval/policy', { policy: 'ask' }, createdAt);

  let titleWritten = false;
  const title = typeof session.title === 'string' && session.title.length > 0 ? session.title : undefined;

  /** A user message opens a turn; assistant messages join it. */
  const turns = [];
  for (const message of messages) {
    const role = message.data?.role;
    if (role === 'user') {
      turns.push({ user: message, assistants: [] });
      continue;
    }
    if (role === 'assistant') {
      if (turns.length === 0) turns.push({ user: undefined, assistants: [] });
      turns[turns.length - 1].assistants.push(message);
      continue;
    }
    stats.skippedParts += 1;
  }

  let turnNumber = 0;
  for (const turn of turns) {
    turnNumber += 1;
    stats.turns += 1;
    const turnTime = ms(turn.user?.data?.time?.created, builder.lastTime);
    builder.push('turn/start', { turn: turnNumber }, turnTime);

    let stepNumber = 0;
    let openStep = false;

    if (turn.user !== undefined) {
      const content = [];
      for (const part of turn.user.parts) {
        if (part.data?.type === 'text' && typeof part.data.text === 'string') {
          content.push({ type: 'text', text: part.data.text });
        } else if (part.data?.type === 'file') {
          stats.fileParts += 1;
          content.push({ type: 'text', text: fileMarker(part.data) });
        } else if (part.data?.type === 'step-start' || part.data?.type === 'step-finish') {
          // ZCode writes step markers on user messages too; they carry no content.
        } else {
          stats.skippedParts += 1;
        }
      }
      if (content.length === 0) content.push({ type: 'text', text: PLACEHOLDER_USER_TEXT });

      stepNumber += 1;
      const userTime = ms(turn.user.data?.time?.created, builder.lastTime);
      builder.push('step/start', { turn: turnNumber, step: stepNumber }, userTime);
      openStep = true;
      builder.push(
        'user/message',
        { content, source: { kind: 'user' }, role: 'user', id: turn.user.id },
        userTime,
      );
      stats.userMessages += 1;

      if (!titleWritten && title !== undefined) {
        builder.push('session/title', { title, messageSeqs: [], source: { kind: 'user' } }, userTime);
        titleWritten = true;
      }
    }

    for (const assistant of turn.assistants) {
      const blocks = [];
      const calls = [];
      for (const part of assistant.parts) {
        const data = part.data;
        switch (data?.type) {
          case 'reasoning':
            if (typeof data.text === 'string' && data.text.length > 0) blocks.push({ type: 'reasoning', text: data.text });
            break;
          case 'text':
            if (typeof data.text === 'string' && data.text.length > 0) blocks.push({ type: 'text', text: data.text });
            break;
          case 'tool': {
            const callId = typeof data.callID === 'string' && data.callID.length > 0 ? data.callID : `call_${randomUUID()}`;
            const name = typeof data.tool === 'string' && data.tool.length > 0 ? data.tool : 'unknown';
            let args;
            try {
              args = JSON.stringify(data.state?.input ?? {});
            } catch {
              args = '{}';
            }
            blocks.push({ type: 'tool-call', id: callId, name, arguments: args });
            calls.push({ callId, name, args, state: data.state ?? {} });
            break;
          }
          case 'file':
            stats.fileParts += 1;
            blocks.push({ type: 'text', text: fileMarker(data) });
            break;
          case 'step-start':
          case 'step-finish':
          case 'timeline':
          case 'compaction':
            stats.skippedParts += 1;
            break;
          default:
            stats.skippedParts += 1;
        }
      }

      if (blocks.length === 0) continue; // nothing renderable: do not open a step

      const assistantTime = ms(assistant.data?.time?.created, builder.lastTime);
      if (!openStep) {
        stepNumber += 1;
        builder.push('step/start', { turn: turnNumber, step: stepNumber }, assistantTime);
        openStep = true;
      }

      const providerId = typeof assistant.data?.providerID === 'string' ? assistant.data.providerID : 'zcode';
      const modelId = typeof assistant.data?.modelID === 'string' ? assistant.data.modelID : 'unknown';
      const tokens = assistant.data?.tokens;
      const usage =
        tokens === undefined
          ? undefined
          : {
              inputTokens: Number.isFinite(tokens.input) ? tokens.input : 0,
              outputTokens: Number.isFinite(tokens.output) ? tokens.output : 0,
              totalTokens: Number.isFinite(tokens.total) ? tokens.total : 0,
              cacheReadTokens: Number.isFinite(tokens.cache?.read) ? tokens.cache.read : 0,
              reasoningTokens: Number.isFinite(tokens.reasoning) ? tokens.reasoning : 0,
            };

      builder.push(
        'assistant/message',
        {
          turn: turnNumber,
          step: stepNumber,
          message: {
            role: 'assistant',
            content: blocks,
            source: { kind: 'model', provider: providerId, model: modelId },
            id: assistant.id,
          },
          ...(usage === undefined ? {} : { usage }),
          stream: [],
        },
        assistantTime,
      );
      stats.assistantMessages += 1;

      const callTime = ms(assistant.data?.time?.completed, assistantTime);
      for (const call of calls) {
        const callSeq = builder.push(
          'tool/call',
          { turn: turnNumber, step: stepNumber, callId: call.callId, name: call.name, arguments: call.args },
          callTime,
        );
        stats.toolCalls += 1;

        const isError = call.state.status !== 'completed';
        if (isError) stats.toolErrors += 1;
        const text = includeToolOutput ? toolResultText(call.state) : '';
        builder.push(
          'tool/result',
          {
            turn: turnNumber,
            step: stepNumber,
            message: {
              source: { kind: 'tool', callId: call.callId },
              content: [
                {
                  type: 'tool-result',
                  toolCallId: call.callId,
                  content: text.length > 0 ? [{ type: 'text', text }] : [],
                  isError,
                },
              ],
              role: 'user',
              id: `result-${call.callId}`,
            },
            sourceEventSeqs: [callSeq],
          },
          callTime,
        );
      }

      builder.push('step/end', { turn: turnNumber, step: stepNumber }, callTime);
      stats.steps += 1;
      openStep = false;
    }

    if (openStep) {
      builder.push('step/end', { turn: turnNumber, step: stepNumber }, builder.lastTime);
      if (turn.user !== undefined) stats.steps += 1;
    }
    builder.push('turn/end', { turn: turnNumber, reason: { kind: 'completed' } }, builder.lastTime);
  }

  const header = {
    version: SESSION_FORMAT_VERSION,
    id: session.dshId,
    createdAt,
    cwd: session.directory,
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: 'standard',
  };

  return { header, events: builder.events, stats };
}
