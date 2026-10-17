const API_URL = import.meta.env.VITE_API_URL as string;
const NEWS_KEY = import.meta.env.VITE_NEWS_API_KEY as string;

export interface Article {
  id: number;
  title: string;
  bodyHtml: string;
  sourceUrl: string;
}

export function getToken(): string | null {
  return localStorage.getItem('token');
}

export async function login(email: string, password: string): Promise<void> {
  const res = await fetch(`${API_URL}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error('Login failed');
  const data = await res.json();
  localStorage.setItem('token', data.token);
}

export async function fetchArticle(id: number): Promise<Article> {
  const res = await fetch(`${API_URL}/articles/${id}?apikey=${NEWS_KEY}`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) throw new Error('Could not load article');
  return res.json();
}
