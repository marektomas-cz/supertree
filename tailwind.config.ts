import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: ['class'],
  content: ['./src/ui/**/*.{ts,tsx,html}'],
  theme: {
    extend: {},
  },
  plugins: [],
};

export default config;
