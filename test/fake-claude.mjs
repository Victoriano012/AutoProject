// A stand-in for the claude CLI on the Agent SDK's stream-json pipes, as
// claude.test.mts drives it: the first message starts a background subagent,
// which finishes once a second message has been answered (or on an interrupt,
// stopped). What it saw is appended to FAKE_CLAUDE_LOG, one JSON line each.
import fs from "node:fs";
import readline from "node:readline";

const note = (entry) => fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(entry) + "\n");
const out = (m) => process.stdout.write(JSON.stringify({ session_id: "s1", uuid: crypto.randomUUID(), ...m }) + "\n");
const say = (text, parent = null) =>
  out({ type: "assistant", parent_tool_use_id: parent, message: { role: "assistant", content: [{ type: "text", text }] } });
const turn = (text) => {
  out({ type: "system", subtype: "init" });
  say(text);
  out({ type: "result", subtype: "success", is_error: false, result: text, modelUsage: {}, queued_turn_count: 0 });
};

let running = false;
const end = (status) => {
  if (!running) return;
  running = false;
  note({ task: status });
  out({ type: "system", subtype: "task_notification", task_id: "t1", tool_use_id: "toolu_w", status, output_file: "", summary: "" });
  out({ type: "system", subtype: "background_tasks_changed", tasks: [] });
  if (status === "completed") turn("The worker finished.");
};
// Never hang a test whose code stops listening: the work ends by itself.
const deadline = setTimeout(() => end("completed"), 10_000);

let heard = 0;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.type === "control_request") {
    if (m.request.subtype === "interrupt") end("stopped");
    out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: {} } });
    return;
  }
  if (m.type !== "user") return;
  note({ heard: m.message.content, running });
  if (++heard === 1) {
    out({ type: "system", subtype: "init" });
    out({
      type: "assistant",
      parent_tool_use_id: null,
      message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_w", name: "Agent", input: { description: "Sleep", subagent_type: "worker" } }] },
    });
    running = true;
    out({ type: "system", subtype: "task_started", task_id: "t1", tool_use_id: "toolu_w", description: "Sleep", is_backgrounded: true });
    out({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "t1", task_type: "local_agent", description: "Sleep" }] });
    out({
      type: "user",
      parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_w", content: "Async agent launched successfully." }] },
    });
    say("launched");
    out({ type: "result", subtype: "success", is_error: false, result: "launched", modelUsage: {}, queued_turn_count: 0 });
    say("sleeping", "toolu_w");
  } else {
    turn("4");
    end("completed");
  }
});
process.stdin.on("end", () => {
  note({ closed: true, running });
  clearTimeout(deadline);
});
