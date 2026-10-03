import { Plugin } from "@opencode/plugin";
import { execFileSync } from "node:child_process";

export default Plugin.define({
  id: "context.compaction",
  async setup(ctx) {
    const directory = ctx.location.directory;
    let lastTask = "";
    const capture = (text) => {
      if (text && text.trim().length >= 40) lastTask = text.trim();
    };
    const EDIT_TOOLS = ["edit", "write", "apply_patch"];

    await ctx.session.hook("prompt", (event) => {
      capture(event?.prompt?.text ?? "");
    });

    await ctx.tool.hook("execute.after", (event) => {
      try {
        if (event?.status !== "completed" || !EDIT_TOOLS.includes(event.tool) || !directory) return;
        const args = event.input ?? {};
        // opencode: edit/write carry filePath; apply_patch carries marker lines
        // in patchText (docs: check "apply_patch", not "patch")
        let file = args.filePath ?? args.path ?? args.file_path ?? null;
        if (!file && event.tool === "apply_patch" && typeof args.patchText === "string") {
          file = args.patchText.match(/^\*\*\*\s+(?:Add|Update)\s+File:\s+(.+)$/m)?.[1] ?? null;
        }
        if (!file) return;
        const txt = execFileSync("context", ["hook-edit", "--text"], {
          input: JSON.stringify({ file_path: file, cwd: directory }),
          encoding: "utf8",
        }).trim();
        if (!txt) return;
        const prev = event.result?.content;
        event.result = {
          ...event.result,
          content: typeof prev === "string"
            ? (prev ? prev + "\n\n" + txt : txt)
            : Array.isArray(prev)
              ? [...prev, { type: "text", text: txt }]
              : txt,
        };
      } catch {}
    });

    await ctx.session.hook("compaction", (event) => {
      try {
        if (!lastTask || !directory) return;
        const cap = execFileSync("context", ["observe", lastTask, "--budget", "600", "--json"], {
          encoding: "utf8",
          cwd: directory,
        });
        const c = JSON.parse(cap);
        event.system.push({
          type: "text",
          text: "[context capsule — navigation only]\n" +
            "working_tree: " + (c.workingTree ?? "") + "\n" +
            "directories: " + (c.dirs ?? []).map((d) => d.path).join(", ") + "\n" +
            "paths: " + (c.files ?? []).join(", ") + "\n" +
            "hits: " + (c.hits ?? []).map((h) => h.name + " " + h.file + ":" + h.line).join("; ") + "\n" +
            "expand with: context expand " + (c.hits?.[0]?.handle ?? ""),
        });
      } catch {}
    });
  },
});
