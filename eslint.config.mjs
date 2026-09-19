import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

// Next.js 16 removed `next lint`; ESLint is run directly (`npm run lint`).
// eslint-config-next 16 ships native flat configs, so FlatCompat is no
// longer needed.
const eslintConfig = defineConfig([
  ...nextVitals,
  {
    rules: {
      // eslint-config-next 16 enables the React Compiler lint rules. They
      // flag a few existing patterns (setState inside sync effects, a
      // callback storing itself in a ref, `window.location.href = ...`)
      // that work today but should be revisited when the React Compiler is
      // adopted. Keep them visible as warnings rather than failing CI.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/immutability": "warn",
    },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "node_modules/**",
    "lean-sandbox/**",
    ".data/**",
  ]),
]);

export default eslintConfig;
