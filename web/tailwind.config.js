/** @type {import('tailwindcss').Config} */
// Arbr design system — developer-tool aesthetic.
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        arbr: {
          green: {
            50:  "#f0fdf4",
            100: "#dcfce7",
            200: "#bbf7d0",
            300: "#86efac",
            400: "#4ade80",
            500: "#22c55e",
            600: "#16a34a",
            700: "#15803d",
            800: "#166534",
          },
          charcoal: "#0f172a",
          ink:      "#020617",
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
        sans: ['Inter', 'system-ui', 'sans-serif'],
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
