'use client';

// Settings → Radar de Leads (FASE 6, §10.5): é AQUI que o dono ensina a
// IA a pensar como a loja dele — em português, como se explicasse para
// um vendedor no primeiro dia. Sem isso o Radar usa critérios genéricos
// (que funcionam, mas não têm a alma do negócio).

import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Flame, Loader2, Radar, Snowflake, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

interface RadarForm {
  radar_enabled: boolean;
  contexto_negocio: string;
  criterios_quente: string;
  criterios_morno: string;
  criterios_frio: string;
}

const EMPTY: RadarForm = {
  radar_enabled: true,
  contexto_negocio: '',
  criterios_quente: '',
  criterios_morno: '',
  criterios_frio: '',
};

export function RadarSettings() {
  const t = useTranslations('Settings.radar');
  const supabase = createClient();
  const { accountId } = useAuth();
  const [form, setForm] = useState<RadarForm>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const fetchSettings = useCallback(async () => {
    const { data } = await supabase
      .from('followup_settings')
      .select(
        'radar_enabled, contexto_negocio, criterios_quente, criterios_morno, criterios_frio',
      )
      .maybeSingle();
    if (data) {
      setForm({
        radar_enabled: data.radar_enabled ?? true,
        contexto_negocio: data.contexto_negocio ?? '',
        criterios_quente: data.criterios_quente ?? '',
        criterios_morno: data.criterios_morno ?? '',
        criterios_frio: data.criterios_frio ?? '',
      });
    }
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    // setState pós-await, padrão das demais telas.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchSettings();
  }, [fetchSettings]);

  async function handleSave() {
    if (!accountId) return;
    setSaving(true);
    const { error } = await supabase.from('followup_settings').upsert(
      {
        account_id: accountId,
        radar_enabled: form.radar_enabled,
        contexto_negocio: form.contexto_negocio.trim() || null,
        criterios_quente: form.criterios_quente.trim() || null,
        criterios_morno: form.criterios_morno.trim() || null,
        criterios_frio: form.criterios_frio.trim() || null,
      },
      { onConflict: 'account_id' },
    );
    setSaving(false);
    if (error) {
      toast.error(t('saveFailed'));
      return;
    }
    toast.success(t('saved'));
  }

  const field = (key: keyof RadarForm) => ({
    value: form[key] as string,
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value })),
  });

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Radar className="h-4 w-4 text-primary" /> {t('title')}
            </CardTitle>
            <CardDescription>{t('description')}</CardDescription>
          </div>
          <Switch
            checked={form.radar_enabled}
            onCheckedChange={(checked) =>
              setForm((f) => ({ ...f, radar_enabled: checked }))
            }
            aria-label={t('enabled')}
          />
        </div>
      </CardHeader>

      <CardContent className="space-y-5">
        <div className="space-y-1.5">
          <Label className="text-muted-foreground">{t('contextLabel')}</Label>
          <Textarea
            {...field('contexto_negocio')}
            rows={3}
            placeholder={t('contextPlaceholder')}
            className="bg-muted border-border text-foreground"
          />
          <p className="text-xs text-muted-foreground">{t('contextHint')}</p>
        </div>

        <div className="space-y-3">
          <p className="text-sm font-medium text-foreground">
            {t('criteriaTitle')}
          </p>
          <p className="text-xs text-muted-foreground">{t('criteriaHint')}</p>

          <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5 text-red-400">
              <Flame className="h-3.5 w-3.5" /> {t('hotLabel')}
            </Label>
            <Textarea
              {...field('criterios_quente')}
              rows={3}
              placeholder={t('hotPlaceholder')}
              className="bg-muted border-border text-foreground"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5 text-amber-400">
              <Sun className="h-3.5 w-3.5" /> {t('warmLabel')}
            </Label>
            <Textarea
              {...field('criterios_morno')}
              rows={2}
              placeholder={t('warmPlaceholder')}
              className="bg-muted border-border text-foreground"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5 text-sky-400">
              <Snowflake className="h-3.5 w-3.5" /> {t('coldLabel')}
            </Label>
            <Textarea
              {...field('criterios_frio')}
              rows={2}
              placeholder={t('coldPlaceholder')}
              className="bg-muted border-border text-foreground"
            />
          </div>
        </div>

        <div className="flex justify-end">
          <Button
            onClick={() => void handleSave()}
            disabled={saving}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {t('save')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
