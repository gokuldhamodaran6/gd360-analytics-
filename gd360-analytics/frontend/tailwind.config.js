/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        base: "#0B0B14",
        surface: "#13131F",
        surface2: "#1A1A2C",
        border: "#26263C",
        primary: "#6C5CE7",
        accent: "#00D1B2",
        text: "#E8E8F0",
        muted: "#9494B8",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
      },
      boxShadow: {
        glow: "0 0 40px rgba(108,92,231,0.25)",
      },
    },
  },
  plugins: [],
};
