'use client';

// Passo 1 do wizard de broadcasts inteligentes (motor Evolution):
// escrever a mensagem livre com variáveis {{nome}} / {{primeiro_nome}} /
// {{telefone}} e ver o preview renderizado como o cliente vai receber.
// Substitui o antigo "escolher template da Meta".

import { useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { renderBroadcastMessage } from '@/lib/whatsapp/broadcast-pacing';

const VARIABLES = ['{{nome}}', '{{primeiro_nome}}', '{{telefone}}'] as const;

const PREVIEW_CONTACT = { name: 'Eduardo Maciel', phone: '+55 51 98230-0000' };

interface Step1ComposeMessageProps {
  messageText: string;
  onChange: (text: string) => void;
  onNext: () => void;
  onBack: () => void;
}

export function Step1ComposeMessage({
  messageText,
  onChange,
  onNext,
  onBack,
}: Step1ComposeMessageProps) {
  const t = useTranslations('Broadcasts.compose');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  function insertVariable(variable: string) {
    const el = textareaRef.current;
    if (!el) {
      onChange(messageText + variable);
      return;
    }
    const start = el.selectionStart ?? messageText.length;
    const end = el.selectionEnd ?? messageText.length;
    const next = messageText.slice(0, start) + variable + messageText.slice(end);
    onChange(next);
    // Reposiciona o cursor logo após a variável inserida.
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + variable.length;
      el.setSelectionRange(pos, pos);
    });
  }

  const preview = messageText.trim()
    ? renderBroadcastMessage(messageText, PREVIEW_CONTACT)
    : '';

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor="broadcast-message" className="text-muted-foreground">
          {t('label')}
        </Label>
        <Textarea
          id="broadcast-message"
          ref={textareaRef}
          value={messageText}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t('placeholder')}
          rows={7}
          className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
        />
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">{t('variablesHint')}</span>
          {VARIABLES.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => insertVariable(v)}
              className="rounded-md border border-border bg-muted px-2 py-0.5 font-mono text-xs text-primary transition-colors hover:bg-primary/10"
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      {preview && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">
            {t('previewLabel', { name: PREVIEW_CONTACT.name })}
          </p>
          {/* Balão estilo WhatsApp, mesmo visual do inbox (tokens wa-*). */}
          <div className="rounded-lg bg-wa-out px-3 py-2 text-sm whitespace-pre-wrap text-wa-out-foreground max-w-md">
            {preview}
          </div>
        </div>
      )}

      <div className="flex justify-between">
        <Button
          variant="outline"
          onClick={onBack}
          className="border-border text-muted-foreground hover:bg-muted"
        >
          {t('back')}
        </Button>
        <Button
          onClick={onNext}
          disabled={!messageText.trim()}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
        >
          {t('next')}
        </Button>
      </div>
    </div>
  );
}
