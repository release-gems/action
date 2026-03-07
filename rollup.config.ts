import commonjs from "@rollup/plugin-commonjs";
import json from "@rollup/plugin-json";
import nodeResolve from "@rollup/plugin-node-resolve";
import replace from "@rollup/plugin-replace";
import { defineConfig } from "rollup";
import license from "rollup-plugin-license";
import typescript from "rollup-plugin-typescript2";

const banner = `\
<% for (const dependency of dependencies) {
%>---

<%= dependency.name %> -- <%= dependency.version %>
<% if (dependency.licenseText) {
%>
## License (<%= dependency.license %>)

<%= dependency.licenseText %>
<% }
%><% if (dependency.noticeText) {
%>
## Notice

<%= dependency.noticeText %>
<% }
%><% }
%>`;

const plugins = [
  nodeResolve({ preferBuiltins: true }),
  commonjs(),
  json(),
  typescript(),
  replace({ "import.meta.vitest": "undefined", preventAssignment: false }),
  license({
    banner,
    thirdParty: {
      includePrivate: false,
      includeSelf: true,
      multipleVersions: true,
      output: [],
    },
  }),
];

export default defineConfig([
  {
    input: "src/build.ts",
    output: {
      file: "build/index.js",
      format: "cjs",
      inlineDynamicImports: true,
    },
    plugins,
  },
  {
    input: "src/publish.ts",
    output: {
      file: "index.js",
      format: "cjs",
      inlineDynamicImports: true,
    },
    plugins,
  },
]);
