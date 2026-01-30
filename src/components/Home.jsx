import React, { useEffect, useRef } from 'react';

const ASCII_CHARS = "~*+|";

const Home = ({ onStart }) => {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    let animationFrame;

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    window.addEventListener('resize', resize);
    resize();

    // ASCII Flow Logic
    const fontSize = 16;
    const columns = Math.ceil(window.innerWidth / fontSize);
    const drops = Array(columns).fill(0).map(() => Math.random() * -100);

    const draw = () => {
      // Clear with slight transparency for trail, but we want a clean look as per "Silver White"
      // "Flowing, semi-transparent ASCII characters simulating water fluctuation"
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      // We redraw everything each frame to avoid murky trails if we want a clean "gallery" look
      // But user said "flowing... semi-transparent".
      // Let's use a subtle motion.
      
      ctx.fillStyle = '#1F2937'; // Dark gray text
      ctx.font = `${fontSize}px monospace`;
      ctx.textBaseline = 'top';

      for (let i = 0; i < drops.length; i++) {
        const text = ASCII_CHARS[Math.floor(Math.random() * ASCII_CHARS.length)];
        const x = i * fontSize;
        const y = drops[i] * fontSize;

        // Opacity based on position or random to simulate "shimmer"
        ctx.globalAlpha = 0.1 + Math.random() * 0.2; 
        ctx.fillText(text, x, y);

        if (y > canvas.height && Math.random() > 0.98) {
          drops[i] = -fontSize;
        }
        drops[i] += 0.5; // Slow speed
      }
      
      animationFrame = requestAnimationFrame(draw);
    };

    draw();

    return () => {
      window.removeEventListener('resize', resize);
      cancelAnimationFrame(animationFrame);
    };
  }, []);

  return (
    <div style={{ 
      position: 'relative', 
      width: '100vw', 
      height: '100vh', 
      background: 'linear-gradient(to bottom, #E5E7EB, #F9FAFB)',
      overflow: 'hidden',
      fontFamily: '"Times New Roman", serif' 
    }}>
      <canvas 
        ref={canvasRef} 
        style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }} 
      />
      
      <div style={{
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        textAlign: 'center',
        zIndex: 10,
        width: '100%'
      }}>
        <h1 style={{ 
          fontSize: '4rem', 
          fontWeight: 'bold', 
          color: '#1F2937', 
          letterSpacing: '0.2em',
          marginBottom: '3rem',
          textShadow: '0 4px 6px rgba(0,0,0,0.05)'
        }}>
          HEALING FLOW
        </h1>
        
        <button 
          onClick={onStart}
          style={{
            background: 'transparent',
            border: '1px solid #9CA3AF',
            padding: '12px 48px',
            fontSize: '1rem',
            color: '#374151',
            cursor: 'pointer',
            transition: 'all 0.4s ease',
            fontFamily: 'sans-serif',
            letterSpacing: '0.15em',
            borderRadius: '2px',
            textTransform: 'uppercase'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.boxShadow = '0 0 20px rgba(156, 163, 175, 0.4)';
            e.currentTarget.style.borderColor = '#1F2937';
            e.currentTarget.style.color = '#1F2937';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.boxShadow = 'none';
            e.currentTarget.style.borderColor = '#9CA3AF';
            e.currentTarget.style.color = '#374151';
          }}
        >
          Enter
        </button>
      </div>
    </div>
  );
};

export default Home;
