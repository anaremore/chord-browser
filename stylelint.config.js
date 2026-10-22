/**
 * Components may only use design tokens (DESIGN.md §4.1). Raw colors, pixel
 * lengths and durations are allowed only inside packages/tokens.
 */
export default {
  extends: ['stylelint-config-standard'],
  rules: {
    'color-no-hex': true,
    'color-named': 'never',
    'function-disallowed-list': ['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color'],
    'unit-disallowed-list': ['px', 'ms', 's'],
    'selector-class-pattern': null,
    // CSS Modules
    'selector-pseudo-class-no-unknown': [true, { ignorePseudoClasses: ['global'] }],
    'custom-property-pattern': null,
    'value-keyword-case': ['lower', { camelCaseSvgKeywords: true, ignoreKeywords: ['/^[A-Z]/'] }],
  },
  overrides: [
    {
      files: ['packages/tokens/**/*.css'],
      rules: {
        'color-no-hex': null,
        'function-disallowed-list': null,
        'unit-disallowed-list': null,
      },
    },
  ],
};
