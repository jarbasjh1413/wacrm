'use client';

// Passo final do wizard de broadcasts inteligentes: nome, envio agora ou
// agendado, resumo da mensagem/público e o aviso das regras anti-ban
// (§11 — a fila do servidor envia 1 por vez com intervalo aleatório,
// em horário comercial e com teto diário).

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { AudienceConfig } from '@/hooks/use-broadcast-sending';

interface Step3ReviewSendProps {
  name: string;
  onNameChange: (name: string) => void;
  messageText: string;
  audience: AudienceConfig;
  /** scheduledAt ISO ou null = fila imediata. */
  onSend: (scheduledAt: string | null) => void;
  onSaveDraft: () => void;
  onBack: () => void;
  isProcessing: boolean;
}

export function Step3ReviewSend({
  name,
  onNameChange,
  messageText,
  audience,
  onSend,
  onSaveDraft,
  onBack,
  isProcessing,
}: Step3ReviewSendProps) {
  const t = useTranslations('Broadcasts.review');
  const [mode, setMode] = useState<'now' | 'schedule'>('now');
  const [scheduledAt, setScheduledAt] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);

  const audienceLabel = t(`audience.${audience.type}`);
  const canSend =
    Boolean(name.trim()) &&
    !isProcessing &&
    (mode === 'now' || Boolean(scheduledAt));

  function confirmSend() {
    setConfirmOpen(false);
    onSend(
      mode === 'schedule' && scheduledAt
        ? new Date(scheduledAt).toISOString()
        : null,
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor="broadcast-name" className="text-muted-foreground">
          {t('nameLabel')}
        </Label>
        <Input
          id="broadcast-name"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder={t('namePlaceholder')}
          className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
        />
      </div>

      {/* Resumo */}
      <div className="space-y-3 rounded-lg border border-border bg-card p-4">
        <div>
          <p className="text-xs font-medium text-muted-foreground">{t('summaryAudience')}</p>
          <p className="text-sm text-foreground">{audienceLabel}</p>
        </div>
        <div>
          <p className="text-xs font-medium text-muted-foreground">{t('summaryMessage')}</p>
          <p className="whitespace-pre-wrap text-sm text-foreground line-clamp-6">{messageText}</p>
        </div>
      </div>

      {/* Quando enviar */}
      <div className="space-y-2">
        <Label className="text-muted-foreground">{t('whenLabel')}</Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            onClick={() => setMode('now')}
            className={`flex-1 rounded-lg border px-4 py-3 text-left text-sm transition-colors ${
              mode === 'now'
                ? 'border-primary bg-primary/10 text-foreground'
                : 'border-border bg-muted text-muted-foreground hover:border-primary/40'
            }`}
          >
            {t('sendNow')}
          </button>
          <button
            type="button"
            onClick={() => setMode('schedule')}
            className={`flex-1 rounded-lg border px-4 py-3 text-left text-sm transition-colors ${
              mode === 'schedule'
                ? 'border-primary bg-primary/10 text-foreground'
                : 'border-border bg-muted text-muted-foreground hover:border-primary/40'
            }`}
          >
            {t('schedule')}
          </button>
        </div>
        {mode === 'schedule' && (
          <Input
            type="datetime-local"
            value={scheduledAt}
            onChange={(e) => setScheduledAt(e.target.value)}
            className="border-border bg-muted text-foreground sm:max-w-xs"
          />
        )}
      </div>

      {/* Aviso anti-ban */}
      <div className="flex gap-3 rounded-lg border border-primary/20 bg-primary/5 p-4 text-sm text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <p>{t('antiBanNotice')}</p>
      </div>

      <div className="flex items-center justify-between">
        <Button
          variant="outline"
          onClick={onBack}
          disabled={isProcessing}
          className="border-border text-muted-foreground hover:bg-muted"
        >
          {t('back')}
        </Button>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={onSaveDraft}
            disabled={!name.trim() || isProcessing}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {t('saveDraft')}
          </Button>
          <Button
            onClick={() => setConfirmOpen(true)}
            disabled={!canSend}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {isProcessing
              ? t('processing')
              : mode === 'schedule'
                ? t('scheduleButton')
                : t('sendButton')}
          </Button>
        </div>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="bg-popover border-border sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {t('confirmTitle')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {mode === 'schedule'
                ? t('confirmDescScheduled')
                : t('confirmDescNow')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmOpen(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button
              onClick={confirmSend}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {t('confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
