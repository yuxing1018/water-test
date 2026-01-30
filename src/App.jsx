import React, { useState } from 'react';
import Experience from './components/Experience';
import Home from './components/Home';

function App() {
  const [started, setStarted] = useState(false);

  return (
    <div style={{ width: '100vw', height: '100vh', background: 'black', position: 'relative' }}>
      {!started && <Home onStart={() => setStarted(true)} />}
      {started && <Experience />}
    </div>
  );
}

export default App;
