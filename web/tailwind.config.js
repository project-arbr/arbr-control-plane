/** @type {import('tailwindcss').Config} */
// Arbr design system — monochrome charcoal-on-paper brand (projectarbr.org).
// Chrome is charcoal/paper only. `arbr.accent` is the interactive/emphasis ramp
// (all charcoal tints); color is reserved for semantic status, using Tailwind's
// stock green/amber/red at call sites. Source letterforms/colors: assets/brand/.
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        arbr: {
          charcoal: "#171817",  // brand ink: text, primary buttons, active/interactive states
          ink:      "#0b0b0b",  // hover / near-black
          paper:    "#f3f2ed",  // app background (warm off-white)
          surface:  "#ffffff",  // cards
          // Interactive + emphasis ramp — monochrome. Formerly the brand green;
          // now charcoal tints so nav/tabs/toggles/links/bars read as quiet chrome.
          accent: {
            50:  "#f4f3f0",  // subtle active/panel fill on white
            200: "#dddbd4",  // hairline borders
            500: "#57564f",  // muted
            600: "#171817",  // charcoal — primary interactive
            700: "#141413",  // text / links
            800: "#0b0b0b",  // deep
          },
        },
        gray: {
          50:  "#f9fafb",
          100: "#f3f4f6",
          200: "#e5e7eb",
          300: "#d1d5db",
          400: "#9ca3af",
          500: "#6b7280",
          600: "#4b5563",
          700: "#374151",
          800: "#1f2937",
          900: "#111827",
        },
      },
      fontFamily: {
        sans: ['"Space Grotesk"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"Fira Code"', 'Consolas', 'monospace'],
      },
      borderRadius: {
        lg:    "6px",
        xl:    "10px",
        "2xl": "14px",
      },
      boxShadow: {
        card:  "0 1px 2px 0 rgb(0 0 0 / 0.05), 0 0 0 1px rgb(0 0 0 / 0.04)",
        hover: "0 4px 6px -1px rgb(0 0 0 / 0.07)",
        menu:  "0 8px 24px rgba(0,0,0,0.08)",
      },
    },
  },
  plugins: [],
};
