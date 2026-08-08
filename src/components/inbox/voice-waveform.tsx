'use client';

// Onda da voz ao vivo durante a gravação (réplica do WhatsApp Web).
//
// Lê o nível do microfone de um AnalyserNode e desenha as barras num
// canvas, rolando da direita para a esquerda como no WhatsApp. Canvas
// (e não 60 divs animadas) porque isso redesenha ~30x por segundo e
// precisa não roubar quadros do resto da interface.
//
// Sem analisador (navegador antigo, ou o gravador não expôs o contexto
// de áudio), o componente simplesmente não renderiza nada — a gravação
// continua funcionando sem a onda.

import { useEffect, useRef } from 'react';

interface VoiceWaveformProps {
  /** Analisador ligado ao microfone; null enquanto não houver. */
  analyser: AnalyserNode | null;
  /** Congela a onda (gravação pausada). */
  paused?: boolean;
  className?: string;
}

/** Quantas barras cabem na faixa — mesma densidade do WhatsApp Web. */
const BAR_COUNT = 48;
const BAR_WIDTH = 2;
const BAR_GAP = 2;

export function VoiceWaveform({
  analyser,
  paused = false,
  className,
}: VoiceWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** Histórico de amplitudes (0..1), mais recente no fim. */
  const levelsRef = useRef<number[]>(new Array(BAR_COUNT).fill(0));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !analyser) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const buffer = new Uint8Array(analyser.frequencyBinCount);
    let raf = 0;
    let lastPush = 0;

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);

      // Uma barra nova a cada ~60ms: mais rápido vira ruído visual,
      // mais lento não acompanha a fala.
      if (!paused && now - lastPush > 60) {
        lastPush = now;
        analyser.getByteTimeDomainData(buffer);
        // RMS do sinal — representa volume percebido melhor que o pico.
        let sum = 0;
        for (let i = 0; i < buffer.length; i++) {
          const v = (buffer[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / buffer.length);
        // Ganho + teto: fala normal ocupa boa parte da altura sem estourar.
        levelsRef.current.push(Math.min(1, rms * 3.2));
        levelsRef.current.shift();
      }

      const { width, height } = canvas;
      ctx.clearRect(0, 0, width, height);
      const styles = getComputedStyle(canvas);
      ctx.fillStyle = styles.color;

      const step = BAR_WIDTH + BAR_GAP;
      const centerY = height / 2;
      for (let i = 0; i < BAR_COUNT; i++) {
        const level = levelsRef.current[i] ?? 0;
        // Barras "vazias" viram um ponto na linha central, como no
        // WhatsApp (a faixa nunca fica visualmente vazia).
        const barHeight = Math.max(2, level * (height - 4));
        const x = width - (BAR_COUNT - i) * step;
        if (x < -step) continue;
        ctx.beginPath();
        ctx.roundRect(x, centerY - barHeight / 2, BAR_WIDTH, barHeight, 1);
        ctx.fill();
      }
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [analyser, paused]);

  if (!analyser) return null;

  return (
    <canvas
      ref={canvasRef}
      width={BAR_COUNT * (BAR_WIDTH + BAR_GAP)}
      height={28}
      aria-hidden="true"
      className={className}
    />
  );
}
