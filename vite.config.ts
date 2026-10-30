import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  const base = env.VITE_BASE_URL || "/";
  // `npm run dev:server` (auth API + /rest proxy); see .env.example.
  const apiServer = `http://localhost:${env.PORT || 8787}`;

  return {
    base,
    server: {
      host: "::",
      port: 3000,
      proxy: {
        "/api": apiServer,
        "/rest": apiServer,
      },
    },
    plugins: [react()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
  };
});
