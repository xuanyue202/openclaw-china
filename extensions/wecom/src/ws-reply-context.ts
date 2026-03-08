import type { WecomWsFrame } from "./ws-protocol.js";
import { buildWecomWsRespondMessageCommand, buildWecomWsUpdateTemplateCardCommand, createWecomWsStreamId } from "./ws-protocol.js";

type WsSendFrame = (frame: WecomWsFrame) => Promise<void>;
type WsEventKind = "template_card_event" | "enter_chat" | "feedback_event";

type WsMessageContext = {
  accountId: string;
  reqId: string;
  to: string;
  streamId: string;
  createdAt: number;
  updatedAt: number;
  sessionKey?: string;
  runId?: string;
  started: boolean;
  finished: boolean;
  queue: Promise<void>;
  send: WsSendFrame;
};

type WsEventContext = {
  accountId: string;
  reqId: string;
  to: string;
  kind: WsEventKind;
  createdAt: number;
  updatedAt: number;
  queue: Promise<void>;
  send: WsSendFrame;
};

const MESSAGE_CONTEXT_TTL_MS = 6 * 60 * 1000;
const EVENT_CONTEXT_TTL_MS = 10 * 1000;
const STREAM_FINISH_GRACE_MS = 2_500;

const messageContexts = new Map<string, WsMessageContext>();
const eventContexts = new Map<string, WsEventContext>();
const messageBySessionKey = new Map<string, string>();
const messageByRunId = new Map<string, string>();
const messageByTarget = new Map<string, Set<string>>();
const eventByTarget = new Map<string, Set<string>>();
const finishTimers = new Map<string, NodeJS.Timeout>();

function now(): number {
  return Date.now();
}

function messageKey(accountId: string, reqId: string): string {
  return `${accountId}::${reqId}`;
}

function targetKey(accountId: string, to: string): string {
  return `${accountId}::${to}`;
}

function routeKey(accountId: string, value: string): string {
  return `${accountId}::${value}`;
}

function addTargetIndex(index: Map<string, Set<string>>, key: string, value: string): void {
  const current = index.get(key) ?? new Set<string>();
  current.add(value);
  index.set(key, current);
}

function removeTargetIndex(index: Map<string, Set<string>>, key: string, value: string): void {
  const current = index.get(key);
  if (!current) return;
  current.delete(value);
  if (current.size === 0) {
    index.delete(key);
  }
}

function clearFinishTimer(key: string): void {
  const timer = finishTimers.get(key);
  if (!timer) return;
  clearTimeout(timer);
  finishTimers.delete(key);
}

function trimActiveIds<T extends { updatedAt: number }>(
  ids: Iterable<string>,
  lookup: Map<string, T>,
  ttlMs: number
): string[] {
  const cutoff = now() - ttlMs;
  const active: string[] = [];
  for (const id of ids) {
    const item = lookup.get(id);
    if (!item) continue;
    if (item.updatedAt < cutoff) continue;
    active.push(id);
  }
  return active;
}

function pickNewestContext<T extends { updatedAt: number }>(ids: string[], lookup: Map<string, T>): T | null {
  let newest: T | null = null;
  for (const id of ids) {
    const current = lookup.get(id);
    if (!current) continue;
    if (!newest || current.updatedAt > newest.updatedAt) {
      newest = current;
    }
  }
  return newest;
}

function enqueue<T extends { queue: Promise<void> }>(context: T, task: () => Promise<void>): Promise<void> {
  context.queue = context.queue.then(task, task);
  return context.queue;
}

function pruneMessageContexts(): void {
  const cutoff = now() - MESSAGE_CONTEXT_TTL_MS;
  for (const [key, context] of messageContexts.entries()) {
    if (context.updatedAt >= cutoff) continue;
    clearFinishTimer(key);
    messageContexts.delete(key);
    const sessionKey = context.sessionKey?.trim();
    if (sessionKey) {
      const route = routeKey(context.accountId, sessionKey);
      if (messageBySessionKey.get(route) === key) {
        messageBySessionKey.delete(route);
      }
    }
    const runId = context.runId?.trim();
    if (runId) {
      const route = routeKey(context.accountId, runId);
      if (messageByRunId.get(route) === key) {
        messageByRunId.delete(route);
      }
    }
    removeTargetIndex(messageByTarget, targetKey(context.accountId, context.to), key);
  }
}

function pruneEventContexts(): void {
  const cutoff = now() - EVENT_CONTEXT_TTL_MS;
  for (const [key, context] of eventContexts.entries()) {
    if (context.updatedAt >= cutoff) continue;
    eventContexts.delete(key);
    removeTargetIndex(eventByTarget, targetKey(context.accountId, context.to), key);
  }
}

function pruneContexts(): void {
  pruneMessageContexts();
  pruneEventContexts();
}

function findMessageContext(params: {
  accountId: string;
  to: string;
  sessionKey?: string;
  runId?: string;
}): WsMessageContext | null {
  pruneMessageContexts();
  const accountId = params.accountId.trim();
  const runId = params.runId?.trim();
  const sessionKey = params.sessionKey?.trim();
  const to = params.to.trim();

  if (runId) {
    const key = messageByRunId.get(routeKey(accountId, runId));
    if (key) {
      const context = messageContexts.get(key);
      if (context && !context.finished) return context;
    }
  }

  if (sessionKey) {
    const key = messageBySessionKey.get(routeKey(accountId, sessionKey));
    if (key) {
      const context = messageContexts.get(key);
      if (context && !context.finished) return context;
    }
  }

  const ids = trimActiveIds(messageByTarget.get(targetKey(accountId, to)) ?? [], messageContexts, MESSAGE_CONTEXT_TTL_MS);
  const newest = pickNewestContext(ids, messageContexts);
  if (newest && !newest.finished) return newest;
  return null;
}

function findEventContext(params: {
  accountId: string;
  to: string;
  kind: WsEventKind;
}): WsEventContext | null {
  pruneEventContexts();
  const ids = trimActiveIds(eventByTarget.get(targetKey(params.accountId.trim(), params.to.trim())) ?? [], eventContexts, EVENT_CONTEXT_TTL_MS);
  const matches = ids
    .map((id) => eventContexts.get(id))
    .filter((context): context is WsEventContext => Boolean(context && context.kind === params.kind));
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.updatedAt - a.updatedAt);
  return matches[0] ?? null;
}

export function registerWecomWsMessageContext(params: {
  accountId: string;
  reqId: string;
  to: string;
  send: WsSendFrame;
  streamId?: string;
}): string {
  pruneContexts();
  const key = messageKey(params.accountId.trim(), params.reqId.trim());
  const context: WsMessageContext = {
    accountId: params.accountId.trim(),
    reqId: params.reqId.trim(),
    to: params.to.trim(),
    streamId: params.streamId?.trim() || createWecomWsStreamId(),
    createdAt: now(),
    updatedAt: now(),
    started: false,
    finished: false,
    queue: Promise.resolve(),
    send: params.send,
  };
  messageContexts.set(key, context);
  addTargetIndex(messageByTarget, targetKey(context.accountId, context.to), key);
  return context.streamId;
}

export function registerWecomWsEventContext(params: {
  accountId: string;
  reqId: string;
  to: string;
  kind: WsEventKind;
  send: WsSendFrame;
}): void {
  pruneContexts();
  const key = messageKey(params.accountId.trim(), params.reqId.trim());
  const context: WsEventContext = {
    accountId: params.accountId.trim(),
    reqId: params.reqId.trim(),
    to: params.to.trim(),
    kind: params.kind,
    createdAt: now(),
    updatedAt: now(),
    queue: Promise.resolve(),
    send: params.send,
  };
  eventContexts.set(key, context);
  addTargetIndex(eventByTarget, targetKey(context.accountId, context.to), key);
}

export function bindWecomWsRouteContext(params: {
  accountId: string;
  reqId: string;
  sessionKey?: string;
  runId?: string;
}): void {
  pruneMessageContexts();
  const key = messageKey(params.accountId.trim(), params.reqId.trim());
  const context = messageContexts.get(key);
  if (!context) return;
  const sessionKey = params.sessionKey?.trim();
  const runId = params.runId?.trim();
  if (sessionKey) {
    context.sessionKey = sessionKey;
    messageBySessionKey.set(routeKey(context.accountId, sessionKey), key);
  }
  if (runId) {
    context.runId = runId;
    messageByRunId.set(routeKey(context.accountId, runId), key);
  }
  context.updatedAt = now();
}

export async function appendWecomWsActiveStreamChunk(params: {
  accountId: string;
  to: string;
  chunk: string;
  sessionKey?: string;
  runId?: string;
}): Promise<boolean> {
  const context = findMessageContext(params);
  if (!context) return false;
  const content = params.chunk.trim();
  if (!content) return true;
  const key = messageKey(context.accountId, context.reqId);
  clearFinishTimer(key);
  await enqueue(context, async () => {
    await context.send(
      buildWecomWsRespondMessageCommand({
        reqId: context.reqId,
        streamId: context.streamId,
        content,
        finish: false,
      })
    );
    context.started = true;
    context.updatedAt = now();
  });
  return true;
}

export function scheduleWecomWsMessageContextFinish(params: {
  accountId: string;
  reqId: string;
  error?: unknown;
}): void {
  const key = messageKey(params.accountId.trim(), params.reqId.trim());
  clearFinishTimer(key);
  const timer = setTimeout(() => {
    void finishWecomWsMessageContext(params);
  }, STREAM_FINISH_GRACE_MS);
  finishTimers.set(key, timer);
}

export async function finishWecomWsMessageContext(params: {
  accountId: string;
  reqId: string;
  error?: unknown;
}): Promise<void> {
  pruneMessageContexts();
  const key = messageKey(params.accountId.trim(), params.reqId.trim());
  clearFinishTimer(key);
  const context = messageContexts.get(key);
  if (!context || context.finished) return;
  await enqueue(context, async () => {
    const errorMessage = params.error ? `Error: ${params.error instanceof Error ? params.error.message : String(params.error)}` : "";
    const sendFinish = context.started || Boolean(errorMessage);
    if (sendFinish) {
      await context.send(
        buildWecomWsRespondMessageCommand({
          reqId: context.reqId,
          streamId: context.streamId,
          content: errorMessage || undefined,
          finish: true,
        })
      );
    }
    context.finished = true;
    context.updatedAt = now();
  });
  messageContexts.delete(key);
  const sessionKey = context.sessionKey?.trim();
  if (sessionKey) {
    const route = routeKey(context.accountId, sessionKey);
    if (messageBySessionKey.get(route) === key) {
      messageBySessionKey.delete(route);
    }
  }
  const runId = context.runId?.trim();
  if (runId) {
    const route = routeKey(context.accountId, runId);
    if (messageByRunId.get(route) === key) {
      messageByRunId.delete(route);
    }
  }
  removeTargetIndex(messageByTarget, targetKey(context.accountId, context.to), key);
}

export async function sendWecomWsActiveTemplateCard(params: {
  accountId: string;
  to: string;
  templateCard: Record<string, unknown>;
}): Promise<boolean> {
  const context = findEventContext({
    accountId: params.accountId,
    to: params.to,
    kind: "template_card_event",
  });
  if (!context) return false;
  await enqueue(context, async () => {
    await context.send(
      buildWecomWsUpdateTemplateCardCommand({
        reqId: context.reqId,
        templateCard: params.templateCard,
      })
    );
    context.updatedAt = now();
  });
  return true;
}

export function clearWecomWsReplyContextsForAccount(accountId: string): void {
  const trimmed = accountId.trim();
  for (const [key, context] of messageContexts.entries()) {
    if (context.accountId !== trimmed) continue;
    clearFinishTimer(key);
    messageContexts.delete(key);
    removeTargetIndex(messageByTarget, targetKey(context.accountId, context.to), key);
    if (context.sessionKey) {
      messageBySessionKey.delete(routeKey(context.accountId, context.sessionKey));
    }
    if (context.runId) {
      messageByRunId.delete(routeKey(context.accountId, context.runId));
    }
  }
  for (const [key, context] of eventContexts.entries()) {
    if (context.accountId !== trimmed) continue;
    eventContexts.delete(key);
    removeTargetIndex(eventByTarget, targetKey(context.accountId, context.to), key);
  }
}
