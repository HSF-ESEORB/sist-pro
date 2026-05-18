import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // OpenRouter Proxy Endpoint
  app.post("/api/ai/generate", async (req, res) => {
    const { prompt, useSearch } = req.body;
    // Prioritize environment variable, fallback to user-provided key for immediate operation
    const apiKey = process.env.OPENROUTER_API_KEY || "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";

    if (!apiKey) {
      return res.status(500).json({ error: "OPENROUTER_API_KEY not configured" });
    }

    try {
      // Use google/gemini-2.0-flash-001 or similar on OpenRouter
      // If useSearch is true, we could use a model that supports search or just pass it in the prompt
      // For OpenRouter, we'll use gemini-2.0-flash-001 as it's versatile
      
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "HTTP-Referer": "https://ais-build.app", // Optional, for OpenRouter tracking
          "X-Title": "SIST-Pro Analiser", // Optional
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "google/gemini-2.0-flash-001", 
          messages: [
            {
              role: "user",
              content: prompt
            }
          ],
          response_format: { type: "json_object" }
        })
      });

      const data = await response.json();
      
      if (data.error) {
        console.error("OpenRouter Error:", data.error);
        return res.status(500).json({ error: data.error.message || "AI Error" });
      }

      const content = data.choices[0].message.content;
      res.json({ text: content });
    } catch (error: any) {
      console.error("Proxy Error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
