import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync, cpSync } from "node:fs";
import { resolve } from "node:path";

const watch = process.argv.includes("--watch");
const outdir = "dist";

mkdirSync(outdir, { recursive: true });

const common = {
  bundle: true,
  format: "iife",
  target: "es2022",
  minify: !watch,
  sourcemap: watch
};

const entries = [
  { in: "src/inpage.ts", out: "inpage" },
  { in: "src/content.ts", out: "content" },
  { in: "src/background.ts", out: "background" },
  { in: "src/popup.ts", out: "popup" }
];

async function build() {
  await Promise.all(
    entries.map((e) =>
      esbuild.build({
        ...common,
        entryPoints: [e.in],
        outfile: `${outdir}/${e.out}.js`
      })
    )
  );

  // Copy static files
  copyFileSync("public/manifest.json", `${outdir}/manifest.json`);
  copyFileSync("public/popup.html", `${outdir}/popup.html`);
  copyFileSync("public/popup.css", `${outdir}/popup.css`);
  cpSync("public/icons", `${outdir}/icons`, { recursive: true });
  console.log(`✓ Built ${entries.length} bundles → ${resolve(outdir)}`);
}

if (watch) {
  for (const e of entries) {
    const ctx = await esbuild.context({ ...common, entryPoints: [e.in], outfile: `${outdir}/${e.out}.js` });
    await ctx.watch();
  }
  console.log("watching…");
} else {
  await build();
}
