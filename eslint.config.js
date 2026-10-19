import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist', 'coverage', 'node_modules', 'drizzle/meta'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.node,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Logs must never carry secrets; enforce structured logging instead of console.
      'no-console': 'error',
    },
  },
  // Configuration is read in exactly one place.
  //
  // `getEnv()` is not only a parser: it refuses to start when the Supabase key is
  // not a service-role token, when the protocol fee does not match the deployed
  // contracts, when Mainnet was not explicitly opted into, and when the database
  // connection would be encrypted but unauthenticated. A direct lookup anywhere
  // else skips every one of those and hands back `string | undefined`, which is
  // how an unvalidated value reaches a pool or a query.
  {
    files: ['src/**/*.ts'],
    ignores: ['src/lib/env.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message:
            'Read configuration through getEnv() in src/lib/env.ts. It validates the value and asserts the startup invariants that a raw lookup bypasses.',
        },
      ],
    },
  },
  // Money is fixed-point, and `src/lib/base-units.ts` is the only module allowed
  // to convert a column into a JavaScript value. Its reasoning applies to every
  // call site: an amount is an i128 held as a string because a JSON number is a
  // double, exact only to 2^53, and a rounded balance is indistinguishable from a
  // correct one to everyone downstream.
  //
  // The selectors below are the shapes that conversion takes by accident — the
  // coercion a reviewer reads as harmless, and the rounding used to "tidy up" a
  // value on the way out. `base-units.ts` is exempt because `assertCount` is the
  // one sanctioned conversion there, and only after proving the value is a safe
  // integer; tests are exempt because constructing a bad input is their job.
  {
    files: ['src/**/*.ts'],
    ignores: ['src/lib/base-units.ts', '**/*.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'CallExpression[callee.name="parseFloat"]',
          message:
            'parseFloat turns an amount into a double, which is exact only to 2^53. Convert through assertBaseUnits()/assertCount() in src/lib/base-units.ts.',
        },
        {
          selector:
            'CallExpression[callee.object.name="Number"][callee.property.name="parseFloat"]',
          message:
            'Number.parseFloat turns an amount into a double, which is exact only to 2^53. Convert through assertBaseUnits()/assertCount() in src/lib/base-units.ts.',
        },
        {
          selector: 'CallExpression[callee.name="Number"]',
          message:
            'Number() on a base-unit string is the silent rounding src/lib/base-units.ts exists to prevent. Convert through assertBaseUnits()/assertCount() instead.',
        },
        {
          selector: 'CallExpression[callee.property.name="toFixed"]',
          message:
            'toFixed rounds a double before formatting it. Amounts are exact base units; format the string, or the last digits of a balance stop being the balance.',
        },
      ],
    },
  },
  // The indexer's tables are read with raw SQL, so drizzle's tagged template is
  // the only thing standing between a value and the statement text. `sql.raw`
  // splices a string in unparameterised — the mistake that turns a filter value
  // into SQL — and nothing needs it: `sql` parameterises values and
  // `sql.identifier` quotes names.
  {
    files: ['src/db/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'CallExpression[callee.object.name="sql"][callee.property.name="raw"]',
          message:
            'sql.raw() splices a string into the statement unparameterised. Use the sql tagged template for values, or sql.identifier() for names.',
        },
      ],
    },
  },
);
