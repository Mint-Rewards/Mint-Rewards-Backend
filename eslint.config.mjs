// Flat config. `npm run lint` failed repo-wide before this file existed
// ("ESLint couldn't find an eslint.config.* file"), so nothing in the backend
// was ever linted — see issue #146 item 1.
//
// Deliberately close to eslint-config-next's defaults plus TypeScript's
// recommended set. The point of the first pass is a gate that runs and passes
// on the existing tree, not a style overhaul: rules that would flag hundreds
// of pre-existing lines are turned down to "warn" here rather than off, so
// they stay visible without failing CI on day one.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import next from "eslint-config-next";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    // Generated, vendored, or not ours. .worktrees/ matters specifically:
    // it holds full checkouts of other branches and linting it would report
    // findings against code that is not in this branch's diff.
    ignores: [
      "node_modules/**",
      ".next/**",
      ".worktrees/**",
      "next-env.d.ts",
      "coverage/**",
      "public/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...next,
  {
    rules: {
      // Signals a real unused binding, but the codebase uses the
      // `const { password: _password, ...safe }` destructure idiom to strip
      // fields from API responses. Underscore-prefixed names are the opt-out.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // Worth fixing, not worth blocking this PR on: `any` appears throughout
      // the older route handlers and each removal is a real typing decision.
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    // Jest injects its globals rather than importing them, and the setup and
    // teardown files are plain CommonJS run outside the module graph.
    files: ["__tests__/**/*.ts", "jest.setup.js", "jest.teardown.js"],
    languageOptions: {
      globals: {
        describe: "readonly",
        it: "readonly",
        test: "readonly",
        expect: "readonly",
        beforeAll: "readonly",
        beforeEach: "readonly",
        afterAll: "readonly",
        afterEach: "readonly",
        jest: "readonly",
        process: "readonly",
        require: "readonly",
        module: "writable",
      },
    },
  },
  {
    // scripts/ are CommonJS .js CLIs run by node directly, not bundled.
    files: ["scripts/**/*.js", "*.js", "*.mjs"],
    languageOptions: {
      globals: { require: "readonly", module: "writable", process: "readonly" },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  // Must stay last: turns off every rule that would fight prettier.
  prettier,
);
