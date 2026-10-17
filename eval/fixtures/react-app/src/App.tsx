import { useState } from 'react';
import { getToken } from './api';
import { ArticleView } from './components/ArticleView';
import { LoginForm } from './components/LoginForm';

export function App() {
  const [signedIn, setSignedIn] = useState(Boolean(getToken()));
  const [articleId, setArticleId] = useState(1);

  return (
    <main>
      <header>
        <img src="/logo.svg" width={32} height={32} />
        <h1>News Reader</h1>
      </header>
      {signedIn ? (
        <>
          <button onClick={() => setArticleId(id => id + 1)}>Next article</button>
          <ArticleView id={articleId} />
        </>
      ) : (
        <LoginForm onDone={() => setSignedIn(true)} />
      )}
      <footer>
        <a href="https://example.test/about" target="_blank">About this app</a>
      </footer>
    </main>
  );
}
