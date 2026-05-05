import { transformAsync } from "@babel/core"
import solidPreset from "babel-preset-solid"
import typescriptPreset from "@babel/preset-typescript"
import { build } from "esbuild"
import { mkdir, readFile, writeFile } from "node:fs/promises"

await mkdir("dist", { recursive: true })

const source = await readFile("src/tui.tsx", "utf8")
const transformed = await transformAsync(source, {
  configFile: false,
  babelrc: false,
  filename: "src/tui.tsx",
  sourceType: "module",
  presets: [
    [solidPreset, { moduleName: "@opentui/solid", generate: "universal" }],
    [typescriptPreset, { allExtensions: true, isTSX: true }],
  ],
})

if (!transformed?.code) {
  throw new Error("Babel transform did not produce code")
}

await build({
  stdin: {
    contents: transformed.code,
    loader: "js",
    resolveDir: ".",
    sourcefile: "src/tui.tsx",
  },
  outfile: "dist/tui.js",
  bundle: false,
  format: "esm",
  platform: "node",
  target: "node20",
  sourcemap: false,
})

await writeFile(
  "dist/tui.d.ts",
  "import type { TuiPluginModule } from '@opencode-ai/plugin/tui';\ndeclare const plugin: TuiPluginModule & { id: string };\nexport default plugin;\n",
  "utf8",
)
