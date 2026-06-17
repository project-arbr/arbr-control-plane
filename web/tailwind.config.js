/** @type {import('tailwindcss').Config} */
// Gyde design system, translated from the SIS MUI themes.
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        gyde: {
          green: {
            50: "#f7fee7",
            100: "#e5fe96",
            200: "#d9f99d",
            300: "#bef264",
            400: "#a3e635",
            500: "#84cc16",
            600: "#698200", // primary
            700: "#5a7000",
            800: "#4a5d00",
          },
          charcoal: "#262626",
          ink: "#1a1a1a",
        },
        gray: {
          50: "#f9fafb",
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
        sans: ['Inter', 'Roboto', 'Helvetica', 'Arial', 'sans-serif'],
      },
      borderRadius: {
        lg: "12px",
        xl: "16px",
      },
      boxShadow: {
        card: "0 1px 3px 0 rgb(0 0 0 / 0.1)",
        hover: "0 4px 6px -1px rgb(0 0 0 / 0.1)",
        menu: "0 4px 20px rgba(0,0,0,0.1)",
      },
    },
  },
  plugins: [],
};
