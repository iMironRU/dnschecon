import type {
  Env,
  WatchDefinition,
  WatchState,
  ResolverState,
} from "./types.js";
import { loadRegistry, resolveResolvers } from "./resolvers.js";
import { pollRound, precheckAuthoritative } from "./poller.js";
import { nextAlarmDelay, isTimedOut } from "./backoff.js";
import {
  sendMessage,
  editMessage,
  buildProgressText,
  buildFinalText,
  buildPrecheckFailText,
  buildStartText,
} from "./telegram.js";
import { writeConvergenceLog } from "./github.js";

export class WatchDO implements DurableObject {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname.split("/").pop();

    switch (action) {
      case "init": {
        const def: WatchDefinition = await request.json();
        return this.handleInit(def);
      }
      case "state":
        return this.handleState();
      case "pause":
        return this.handlePause();
      case "resume":
        return this.handleResume();
      case "cancel":
        return this.handleCancel();
      default:
        return new Response("Not found", { status: 404 });
    }
  }

  async alarm(): Promise<void> {
    const watchState = await this.loadState();
    if (!watchState) return;
    if (watchState.status !== "active") return;

    const registry = await loadRegistry(this.env);
    const roundResults = await pollRound(watchState.definition, watchState.resolvers, registry);

    // Update per-resolver state
    const now = Date.now();
    for (const result of roundResults) {
      watchState.perResolverState[result.resolverName] = {
        result: result.result,
        observedTtl: result.observedTtl,
        observedValues: result.observedValues,
        errorMessage: result.errorMessage,
        lastUpdated: now,
      };
    }

    const def = watchState.definition;
    const resolvers = watchState.resolvers;
    const perState = watchState.perResolverState;

    // Evaluate convergence
    const isFullRound = evaluateFullRound(def, resolvers, perState);

    if (isFullRound) {
      watchState.consecutiveFullRounds++;
    } else {
      watchState.consecutiveFullRounds = 0;
    }

    watchState.roundNo++;

    const converged = watchState.consecutiveFullRounds >= def.convergence.confirmations;
    const timedOut = isTimedOut(def, watchState.startedAt);

    if (converged) {
      watchState.status = "done";
      await this.saveState(watchState);
      await this.notifyFinal(watchState);
      await writeConvergenceLog(watchState, this.env).catch(console.error);
      // No more alarms
      return;
    }

    if (timedOut) {
      watchState.status = "timeout";
      await this.saveState(watchState);
      await this.notifyFinal(watchState);
      await writeConvergenceLog(watchState, this.env).catch(console.error);
      return;
    }

    // Schedule next alarm
    const delayMs = nextAlarmDelay(def, watchState.roundNo);
    await this.state.storage.setAlarm(Date.now() + delayMs);

    // Update progress notification
    if (def.notify.progress !== "off") {
      await this.updateProgress(watchState);
    }

    await this.saveState(watchState);
  }

  private async handleInit(def: WatchDefinition): Promise<Response> {
    const existing = await this.loadState();
    if (existing?.status === "active") {
      return json({ ok: true, message: "already active" });
    }

    const registry = await loadRegistry(this.env);
    let resolvers;
    try {
      resolvers = resolveResolvers(def.resolvers, registry);
    } catch (e) {
      return json({ ok: false, error: String(e) }, 400);
    }

    // Precheck authoritative if requested
    if (def.precheck_authoritative) {
      const precheck = await precheckAuthoritative(def);
      if (!precheck.ok) {
        // Notify about precheck failure and abort
        for (const chatId of def.notify.telegram_chat_ids) {
          await sendMessage(
            this.env.TELEGRAM_BOT_TOKEN,
            chatId,
            buildPrecheckFailText(def, precheck.message)
          );
        }
        const state: WatchState = {
          definition: def,
          resolvers,
          startedAt: Date.now(),
          roundNo: 0,
          perResolverState: {},
          consecutiveFullRounds: 0,
          status: "error",
        };
        await this.saveState(state);
        return json({ ok: false, error: "precheck_failed", message: precheck.message });
      }
    }

    const startedAt = Date.now();
    const watchState: WatchState = {
      definition: def,
      resolvers,
      startedAt,
      roundNo: 0,
      perResolverState: {},
      consecutiveFullRounds: 0,
      status: "active",
    };

    // Send start notification and set progressMessageId for edit-in-place
    const startText = buildStartText(def);
    for (const chatId of def.notify.telegram_chat_ids) {
      const msgId = await sendMessage(this.env.TELEGRAM_BOT_TOKEN, chatId, startText);
      if (msgId && def.notify.progress === "edit-in-place" && !watchState.progressMessageId) {
        watchState.progressMessageId = msgId;
      }
    }

    await this.saveState(watchState);

    // Set first alarm
    const delayMs = nextAlarmDelay(def, 0);
    await this.state.storage.setAlarm(Date.now() + delayMs);

    return json({ ok: true, startedAt });
  }

  private async handleState(): Promise<Response> {
    const state = await this.loadState();
    if (!state) return json({ ok: false, error: "not initialized" }, 404);
    return json({ ok: true, state });
  }

  private async handlePause(): Promise<Response> {
    const state = await this.loadState();
    if (!state) return json({ ok: false, error: "not initialized" }, 404);
    if (state.status !== "active") return json({ ok: false, error: "not active" }, 400);
    state.status = "paused";
    await this.state.storage.deleteAlarm();
    await this.saveState(state);
    return json({ ok: true });
  }

  private async handleResume(): Promise<Response> {
    const state = await this.loadState();
    if (!state) return json({ ok: false, error: "not initialized" }, 404);
    if (state.status !== "paused") return json({ ok: false, error: "not paused" }, 400);
    state.status = "active";
    await this.saveState(state);
    const delayMs = nextAlarmDelay(state.definition, state.roundNo);
    await this.state.storage.setAlarm(Date.now() + delayMs);
    return json({ ok: true });
  }

  private async handleCancel(): Promise<Response> {
    const state = await this.loadState();
    if (!state) return json({ ok: false, error: "not initialized" }, 404);
    state.status = "paused";
    await this.state.storage.deleteAlarm();
    await this.saveState(state);
    return json({ ok: true });
  }

  private async loadState(): Promise<WatchState | null> {
    return (await this.state.storage.get<WatchState>("state")) ?? null;
  }

  private async saveState(state: WatchState): Promise<void> {
    await this.state.storage.put("state", state);
  }

  private async notifyFinal(state: WatchState): Promise<void> {
    const text = buildFinalText(state);
    const def = state.definition;
    for (const chatId of def.notify.telegram_chat_ids) {
      if (def.notify.progress === "edit-in-place" && state.progressMessageId) {
        await editMessage(this.env.TELEGRAM_BOT_TOKEN, chatId, state.progressMessageId, text);
      } else {
        await sendMessage(this.env.TELEGRAM_BOT_TOKEN, chatId, text);
      }
    }
  }

  private async updateProgress(state: WatchState): Promise<void> {
    const text = buildProgressText(state);
    const def = state.definition;
    for (const chatId of def.notify.telegram_chat_ids) {
      if (def.notify.progress === "edit-in-place" && state.progressMessageId) {
        await editMessage(this.env.TELEGRAM_BOT_TOKEN, chatId, state.progressMessageId, text).catch(
          () => { /* Ignore edit errors (message too old, etc.) */ }
        );
      } else if (def.notify.progress === "every-round") {
        await sendMessage(this.env.TELEGRAM_BOT_TOKEN, chatId, text);
      }
    }
  }
}

function evaluateFullRound(
  def: WatchDefinition,
  resolvers: { name: string }[],
  perState: Record<string, ResolverState>
): boolean {
  const { mode, quorum } = def.convergence;
  const matchCount = resolvers.filter((r) => perState[r.name]?.result === "match").length;

  if (mode === "all") {
    // All resolvers must match; error resolvers block convergence
    return resolvers.every((r) => perState[r.name]?.result === "match");
  }

  // quorum mode: errors don't block
  const q = quorum ?? Math.ceil(resolvers.length / 2);
  return matchCount >= q;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
