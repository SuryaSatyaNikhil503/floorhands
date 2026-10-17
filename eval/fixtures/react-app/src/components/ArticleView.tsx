import { useEffect, useState } from 'react';
import { fetchArticle, type Article } from '../api';
import { shortTitle } from '../format';

export function ArticleView({ id }: { id: number }) {
  const [article, setArticle] = useState<Article | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const load = () => fetchArticle(id).then(setArticle).catch(e => setError(e.message));
    load();
    setInterval(load, 30000);
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (!article) return <p>Loading…</p>;

  return (
    <article>
      <h2>{shortTitle(article.title)}</h2>
      <div dangerouslySetInnerHTML={{ __html: article.bodyHtml }} />
      <p>
        <a href={article.sourceUrl} target="_blank">Read the original</a>
      </p>
    </article>
  );
}
