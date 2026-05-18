import { db, auth } from '../lib/firebase';
import { 
  collection, 
  doc, 
  setDoc, 
  getDoc, 
  query, 
  where, 
  getDocs, 
  Timestamp,
  serverTimestamp 
} from 'firebase/firestore';

// Helper to call our server-side API proxy
async function callProxy(prompt: string, useSearch: boolean) {
  const response = await fetch("/api/ai/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, useSearch })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `HTTP error! status: ${response.status}`);
  }

  return data;
}

// Error Handling as required by Firebase skill
export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// Cache configuration
const CACHE_EXPIRATION_MS = 4 * 60 * 60 * 1000; // 4 hours for matches
const ANALYSIS_CACHE_EXPIRATION_MS = 24 * 60 * 60 * 1000; // 24 hours for specific analyses

// Retry configuration
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 2000; // 2 seconds

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Robust wrapper for AI calls with exponential backoff for 429 errors
 */
async function withRetry<T>(fn: () => Promise<T>, retries = MAX_RETRIES): Promise<T> {
  let lastError: any;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      const isQuotaError = err.message?.includes("429") || err.message?.includes("quota") || err.message?.includes("RESOURCE_EXHAUSTED");
      const isOverloaded = err.message?.includes("503") || err.message?.includes("overloaded");
      
      if (isQuotaError || isOverloaded) {
        const delay = INITIAL_RETRY_DELAY * Math.pow(2, i);
        console.warn(`Tentativa ${i + 1} falhou (Cota/Sobrecarga). Tentando novamente em ${delay}ms...`);
        await sleep(delay);
        continue;
      }
      throw err; // For other errors (like 400, 403, 404), throw immediately
    }
  }
  throw lastError;
}

export interface Match {
  id: string;
  homeTeam: string;
  awayTeam: string;
  league: string;
  time: string;
  date: string;
  source: string;
  sport: "Futebol" | "Basquete";
  isHighlight: boolean;
}

export interface Analysis {
  recentForm: string;
  h2h: string;
  homeAway: string;
  lineups: string;
  stats: string;
  odds: string;
  prediction: {
    market: string;
    probability: number;
    confidence: "Baixo" | "Médio" | "Alto";
  };
}

export async function fetchDailyMatches(date: string): Promise<Match[]> {
  // 1. Check Firestore Cache
  const path = 'matches';
  try {
    const q = query(collection(db, path), where("date_iso", "==", date));
    const querySnapshot = await getDocs(q);
    if (!querySnapshot.empty) {
      const results: Match[] = [];
      querySnapshot.forEach((doc) => {
        const data = doc.data();
        // Check timestamp (createdAt)
        const createdAt = data.createdAt;
        if (createdAt && (Date.now() - (createdAt as Timestamp).toMillis() < CACHE_EXPIRATION_MS)) {
          results.push({ ...data, id: doc.id } as Match);
        }
      });
      
      if (results.length >= 10) { // If we have a decent amount of cached matches
        console.log(`Usando ${results.length} jogos em cache do Firestore para:`, date);
        return results;
      }
    }
  } catch (e) {
    console.warn("Erro ao ler Firestore para jogos:", e);
    // Fallthrough to AI if Firestore fails or is empty
  }

  const prompt = `Você é um Analista Esportivo Profissional e Investigador de Dados.
Hoje é dia ${date} (formato AAAA-MM-DD).

Sua tarefa CRÍTICA é encontrar jogos de destaque (mínimo de 15-20 jogos) que ocorrem EXATAMENTE no dia ${date}.
Use fontes confiáveis em tempo real, PRIORIZANDO o site 365Scores (www.365scores.com/pt-br), mas também validando em SofaScore, Flashscore ou GE.

Considere as principais competições de:
- Futebol (Ligas Europeias, Brasileirão, Libertadores, Champions, etc)
- Basquete (NBA, NBB, EuroLeague)

Instruções Adicionais:
- Se houver poucos jogos no dia solicitado, busque em ligas secundárias importantes.
- Garanta que os horários correspondam ao fuso horário de Brasília (BRT).
- 'isHighlight' deve ser verdadeiro para confrontos entre times conhecidos ou decisões.

Retorne APENAS um array JSON seguindo estritamente este esquema:
[
  {
    "homeTeam": "Nome do Time Casa",
    "awayTeam": "Nome do Time Fora",
    "league": "Nome da Competição",
    "time": "HH:MM",
    "date": "DD/MM/AAAA",
    "source": "Fonte da informação",
    "sport": "Futebol" | "Basquete",
    "isHighlight": boolean
  }
]`;

  try {
    let response: any;
    
    // Use retry logic for the entire operation
    await withRetry(async () => {
      response = await callProxy(prompt, true);
    });

    if (!response || !response.text) {
      throw new Error("Resposta vazia da IA.");
    }

    const data = JSON.parse(response.text.trim());
    if (!Array.isArray(data) || data.length === 0) {
      console.warn("IA retornou uma lista vazia de jogos.");
      return [];
    }

    console.log(`Sucesso: ${data.length} jogos encontrados.`);
    const results = data.map((m: any) => {
      // Create a deterministic ID based on the teams and league to help with stable caching
      const cleanName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
      const id = `${m.sport}-${cleanName(m.homeTeam)}-${cleanName(m.awayTeam)}-${cleanName(m.league)}-${date}`.substring(0, 100);
      return { ...m, id, date_iso: date };
    });

    // Save to Firestore Cache (if authenticated and verified)
    if (auth.currentUser?.emailVerified) {
      try {
        for (const match of results) {
          await setDoc(doc(db, 'matches', match.id), {
            ...match,
            createdAt: serverTimestamp()
          });
        }
      } catch (e) {
        console.warn("Falha ao salvar jogos no Firestore:", e);
      }
    }

    return results;
  } catch (e: any) {
    console.error("Erro fatal na busca de jogos:", e);
    throw e;
  }
}

export async function analyzeMatch(match: Match): Promise<Analysis> {
  const dateStr = new Date().toISOString().split('T')[0];
  const analysisId = `analysis_${match.id}_${dateStr}`.replace(/\s+/g, '_');
  
  // 1. Check Firestore Cache
  try {
    const analysisDoc = await getDoc(doc(db, 'analyses', analysisId));
    if (analysisDoc.exists()) {
      const data = analysisDoc.data();
      const createdAt = data.createdAt;
      if (createdAt && (Date.now() - (createdAt as Timestamp).toMillis() < ANALYSIS_CACHE_EXPIRATION_MS)) {
        console.log(`Usando análise em cache do Firestore para: ${match.homeTeam} x ${match.awayTeam}`);
        return data as Analysis;
      }
    }
  } catch (e) {
    console.warn("Erro ao ler Firestore para análise:", e);
  }

  const prompt = `Analise PROFISSIONAL para o jogo de HOJE (Data de referência: ${new Date().toISOString().split('T')[0]}, Jogo: ${match.homeTeam} x ${match.awayTeam}):
Esporte: ${match.sport} | Liga: ${match.league} | Horário: ${match.time}

Use a busca para validar:
- Forma recente (últimos 5 jogos)
- Confrontos diretos (H2H)
- Desfalques e lesões confirmadas
- Odds de mercado atuais

Regras:
1. Seja objetivo e baseado em dados.
2. Identifique o mercado com melhor valor (ex: Ambas Marcam, Over 2.5, Handicap +1.5).
3. Estime a probabilidade real de sucesso entre 0-100.
4. Nível de confiança: Baixo, Médio ou Alto.

Retorne APENAS o JSON.`;

  try {
    let response: any;
    
    await withRetry(async () => {
      response = await callProxy(prompt, true);
    });

    if (!response || !response.text) {
      throw new Error("Resposta de análise vazia.");
    }
    
    const analysis = JSON.parse(response.text.trim());

    // Save to Firestore Cache (if authenticated and verified)
    if (auth.currentUser?.emailVerified) {
      try {
        await setDoc(doc(db, 'analyses', analysisId), {
          ...analysis,
          matchId: match.id,
          createdAt: serverTimestamp()
        });
      } catch (e) {
        console.warn("Falha ao salvar análise no Firestore:", e);
      }
    }

    return analysis;
  } catch (e: any) {
    console.error(`Erro ao analisar ${match.homeTeam}:`, e);
    throw new Error(`Falha ao analisar o jogo ${match.homeTeam}.`);
  }
}
