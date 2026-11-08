import { createRequire } from "node:module";
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const require = createRequire(import.meta.url);

// eslint-config-next ships `settings.react.version = "detect"`, which makes
// eslint-plugin-react auto-detect React by calling the ESLint 8-era
// `context.getFilename()`. ESLint 10 removed that method, so on ESLint 10 the
// "detect" path throws before any rule runs:
//   TypeError: Error while loading rule 'react/display-name':
//   contextOrFilename.getFilename is not a function
//     at resolveBasedir (eslint-plugin-react/lib/util/version.js:31)
// Reading the installed React version ourselves does exactly what "detect"
// would have done, never enters that code path, and keeps all 18 react/* rules
// enabled (no coverage lost). Remove once eslint-plugin-react ships ESLint 10
// support — its last release, 7.37.5, predates ESLint 10.0.0.
const reactVersion = require("react/package.json").version;

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  { name: "chase/react-version", settings: { react: { version: reactVersion } } },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated deploy artifacts — never lint these.
    ".open-next/**",
    ".wrangler/**",
    // Vendored MapLibre worker copied on postinstall.
    "public/vendor/**",
  ]),
]);

export default eslintConfig;
