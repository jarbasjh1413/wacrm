'use client';

// Transcrição de áudio (055): o dono cola a chave da OpenAI AQUI — nunca
// no chat, nunca por terceiros. Ela vai criptografada para o banco e
// configurada na Evolution; depois disso os áudios dos clientes chegam
// com o texto junto, e o Radar passa a "ouvir".

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AudioLines, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export function TranscricaoSettings() {
  const t = useTranslations('Settings.transcricao');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  const [keyDraft, setKeyDraft] = useState('');

  const fetchStatus = useCallback(async () => {
    const res = await fetch('/api/ai/transcricao');
    if (res.ok) {
      const data = await res.json();
      setEnabled(data.enabled === true);
      setHasKey(data.has_key === true);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchStatus();
  }, [fetchStatus]);

  const ligar = useCallback(async () => {
    if (!keyDraft.trim()) return;
    setSaving(true);
    const res = await fetch('/api/ai/transcricao', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: keyDraft.trim() }),
    });
    const data = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) {
      toast.error(data.error ?? t('failed'));
      return;
    }
    setKeyDraft('');
    toast.success(t('enabled'));
    if (Array.isArray(data.avisos) && data.avisos.length > 0) {
      toast.warning(String(data.avisos[0]));
    }
    void fetchStatus();
  }, [keyDraft, t, fetchStatus]);

  const desligar = useCallback(async () => {
    setSaving(true);
    const res = await fetch('/api/ai/transcricao', { method: 'DELETE' });
    setSaving(false);
    if (!res.ok) {
      toast.error(t('failed'));
      return;
    }
    toast.success(t('disabled'));
    void fetchStatus();
  }, [t, fetchStatus]);

  if (loading) return null;

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <AudioLines className="h-4 w-4 text-primary" /> {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {enabled && hasKey ? (
          <div className="flex items-center justify-between gap-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4">
            <p className="text-sm text-foreground">{t('activeDesc')}</p>
            <Button
              variant="outline"
              size="sm"
              disabled={saving}
              onClick={() => void desligar()}
              className="shrink-0 border-border text-muted-foreground hover:bg-muted"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : t('turnOff')}
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">{t('howTo')}</p>
            <div className="space-y-1.5">
              <Label className="text-muted-foreground">{t('keyLabel')}</Label>
              <Input
                type="password"
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
                placeholder="sk-…"
                autoComplete="off"
                className="bg-muted border-border text-foreground"
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <p className="text-[11px] text-muted-foreground">{t('privacy')}</p>
              <Button
                size="sm"
                disabled={saving || !keyDraft.trim()}
                onClick={() => void ligar()}
                className="shrink-0 bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : t('turnOn')}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
