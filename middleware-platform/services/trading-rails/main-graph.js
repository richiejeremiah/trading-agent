'use strict';

require('../../utils/langsmith-config');

const { executeTurn } = require('./execute-turn');
const { normalizeState } = require('./state-schema');

let compiledGraph = null;

async function loadLangGraph() {
  try {
    return await import('@langchain/langgraph');
  } catch (e) {
    console.warn('[trading-rails] LangGraph not available:', e.message);
    return null;
  }
}

async function getCheckpointer(LG) {
  const connStr = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  const usePostgres =
    connStr && (process.env.NODE_ENV === 'production' || process.env.LANGGRAPH_USE_POSTGRES === 'true');
  if (usePostgres) {
    try {
      const { PostgresSaver } = await import('@langchain/langgraph-checkpoint-postgres');
      const cp = PostgresSaver.fromConnString(connStr, {
        schema: process.env.LANGGRAPH_CHECKPOINT_SCHEMA || 'public',
      });
      await cp.setup();
      return cp;
    } catch (e) {
      console.warn('[trading-rails] PostgresSaver failed:', e.message);
    }
  }
  return LG ? new LG.MemorySaver() : null;
}

async function getMainGraph() {
  if (compiledGraph) return compiledGraph;
  const LG = await loadLangGraph();
  if (!LG) return null;

  const { StateGraph, Annotation, START, END, MemorySaver } = LG;
  let checkpointer = await getCheckpointer(LG);
  if (!checkpointer) checkpointer = new MemorySaver();

  const TradingAnnotation = Annotation.Root({
    session_id: Annotation(),
    active_lane: Annotation(),
    step: Annotation(),
    flags: Annotation(),
    last_user_message: Annotation(),
    last_reply: Annotation(),
    tools_used_last_turn: Annotation(),
    turn_context: Annotation(),
  });

  const workflow = new StateGraph(TradingAnnotation)
    .addNode('execute_turn', async (state) => {
      const ctx = state.turn_context || {};
      const { state: nextState, reply, toolsUsed } = await executeTurn({
        ...state,
        message: ctx.message || state.last_user_message,
      });
      return {
        ...nextState,
        last_reply: reply,
        tools_used_last_turn: toolsUsed || [],
      };
    })
    .addEdge(START, 'execute_turn')
    .addEdge('execute_turn', END);

  compiledGraph = workflow.compile({ checkpointer });
  return compiledGraph;
}

async function invokeMainGraph(opts = {}) {
  const graph = await getMainGraph();
  const sessionId = String(opts.sessionId || opts.session_id || '').trim() || `sess-${Date.now()}`;
  const message = String(opts.message || '').trim();
  const initial = normalizeState({ session_id: sessionId, last_user_message: message, turn_context: { message } });

  if (!graph) {
    const { state, reply, toolsUsed } = await executeTurn({ ...initial, message, sessionId });
    return { state, reply, toolsUsed };
  }

  const config = { configurable: { thread_id: sessionId } };
  const out = await graph.invoke(
    {
      session_id: sessionId,
      active_lane: initial.active_lane,
      step: initial.step,
      flags: initial.flags,
      last_user_message: message,
      turn_context: { message },
    },
    config
  );

  return {
    state: normalizeState(out),
    reply: out.last_reply || '',
    toolsUsed: out.tools_used_last_turn || [],
  };
}

module.exports = { getMainGraph, invokeMainGraph };
