'use client';

// Settings → Central de Recursos (049) — pedido do Jarbas: "um lugar
// pra ligar e desligar esses recursos, testar se está funcionando,
// monitorar. Se eu quiser que seja só um app onde eu respondo à mão, é."
//
// Cada recurso: interruptor, selo de saúde, botão Testar e quando rodou
// pela última vez. No topo, o disjuntor: MODO MANUAL derruba tudo.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  Bot,
  CalendarClock,
  CheckCircle2,
  CircleAlert,
  Clapperboard,
  Eye,
  Hand,
  Handshake,
  Loader2,
  Mic,
  Radar,
  Radio,
  SlidersHorizontal,
  Workflow,
  Zap,
} from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { formatMediumDateTime } from '@/lib/app-locale';
import { cn } from '@/lib/utils';
import {
  FEATURES,
  MANUAL_MODE,
  isEnabled,
  isManualMode,
  toFeatureState,
  type FeatureKey,
  type FeatureState,
} from '@/lib/features/catalog';

type Health = 'ok' | 'off' | 'unconfigured' | 'error';

interface StatusRow {
  feature: string;
  health: Health;
  detail: string | null;
  lastActivity: string | null;
}

const ICONS: Record<FeatureKey, typeof Radar> = {
  radar: Radar,
  followup: Handshake,
  auto_reply: Bot,
  automations: Zap,
  flows: Workflow,
  broadcasts: Radio,
  scheduled: CalendarClock,
  transcription: Mic,
  vision: Eye,
};

/** Recursos com teste funcional na rota de diagnóstico. */
const TESTABLE: ReadonlySet<string> = new Set([
  'radar',
  'followup',
  'auto_reply',
  'automations',
  'flows',
  'broadcasts',
  'scheduled',
]);

const HEALTH_STYLE: Record<Health, string> = {
  ok: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
  off: 'border-border bg-muted text-muted-foreground',
  unconfigured: 'border-amber-500/30 bg-amber-500/10 text-amber-400',
  error: 'border-red-500/30 bg-red-500/10 text-red-400',
};

export function FeaturesCenter() {
  const t = useTranslations('Settings.features');
  const supabase = createClient();
  const { accountId, accountRole } = useAuth();
  const canEdit = accountRole === 'owner' || accountRole === 'admin';

  const [state, setState] = useState<FeatureState>({});
  const [statuses, setStatuses] = useState<StatusRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    const [featuresRes, statusRes] = await Promise.all([
      supabase.from('account_features').select('feature, enabled'),
      fetch('/api/features/status')
        .then((r) => r.json())
        .catch(() => ({ statuses: [] })),
    ]);
    setState(toFeatureState(featuresRes.data));
    setStatuses(statusRes?.statuses ?? []);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    // setState pós-await, padrão das demais telas.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchAll();
  }, [fetchAll]);

  const statusByFeature = useMemo(
    () => new Map(statuses.map((s) => [s.feature, s])),
    [statuses],
  );
  const manual = isManualMode(state);

  async function toggle(feature: string, next: boolean) {
    if (!accountId || !canEdit) return;
    const previous = state[feature];
    setState((prev) => ({ ...prev, [feature]: next }));
    setSaving(feature);
    const { error } = await supabase.from('account_features').upsert(
      { account_id: accountId, feature, enabled: next, updated_at: new Date().toISOString() },
      { onConflict: 'account_id,feature' },
    );
    setSaving(null);
    if (error) {
      setState((prev) => ({ ...prev, [feature]: previous }));
      toast.error(t('saveFailed'));
      return;
    }
    if (feature === MANUAL_MODE) {
      toast.success(next ? t('manualOnToast') : t('manualOffToast'));
    }
  }

  async function test(feature: string) {
    setTesting(feature);
    try {
      const res = await fetch('/api/features/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feature }),
      });
      const payload = await res.json();
      if (payload.ok) toast.success(payload.message ?? t('testOk'));
      else toast.error(payload.message ?? t('testFailed'));
      void fetchAll();
    } catch {
      toast.error(t('testFailed'));
    } finally {
      setTesting(null);
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Disjuntor geral */}
      <Card
        className={cn(
          'transition-colors',
          manual && 'border-amber-500/40 bg-amber-500/5',
        )}
      >
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Hand
                  className={cn(
                    'h-4 w-4',
                    manual ? 'text-amber-400' : 'text-muted-foreground',
                  )}
                />
                {t('manualTitle')}
              </CardTitle>
              <CardDescription>
                {manual ? t('manualOnDesc') : t('manualOffDesc')}
              </CardDescription>
            </div>
            <Switch
              checked={manual}
              disabled={!canEdit || saving === MANUAL_MODE}
              onCheckedChange={(checked) => void toggle(MANUAL_MODE, checked)}
              aria-label={t('manualTitle')}
            />
          </div>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <SlidersHorizontal className="h-4 w-4 text-primary" /> {t('title')}
          </CardTitle>
          <CardDescription>{t('description')}</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <ul className="divide-y divide-border">
            {FEATURES.map((feature) => {
              const Icon = ICONS[feature];
              const status = statusByFeature.get(feature);
              const on = isEnabled(state, feature);
              // Modo manual ligado: mostra tudo apagado, mas preserva a
              // escolha individual (ao desligar o manual, volta como era).
              const ownSwitch = state[feature] !== false;
              const health: Health = manual
                ? 'off'
                : !ownSwitch
                  ? 'off'
                  : (status?.health ?? 'ok');

              return (
                <li key={feature} className="flex items-start gap-3 px-4 py-3">
                  <span
                    className={cn(
                      'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg',
                      on ? 'bg-primary-soft text-primary' : 'bg-muted text-muted-foreground',
                    )}
                  >
                    <Icon className="size-4" />
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-foreground">
                        {t(`items.${feature}.name`)}
                      </span>
                      <span
                        className={cn(
                          'flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px]',
                          HEALTH_STYLE[health],
                        )}
                      >
                        {health === 'ok' ? (
                          <CheckCircle2 className="size-2.5" />
                        ) : health === 'off' ? null : (
                          <CircleAlert className="size-2.5" />
                        )}
                        {t(`health.${health}`)}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
                      {t(`items.${feature}.desc`)}
                    </p>
                    {status?.detail && (
                      <p className="mt-0.5 text-[11px] text-muted-foreground/80">
                        {status.detail}
                      </p>
                    )}
                    {status?.lastActivity && (
                      <p className="mt-0.5 text-[10px] text-muted-foreground/70">
                        {t('lastActivity', {
                          date: formatMediumDateTime(status.lastActivity),
                        })}
                      </p>
                    )}
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    {TESTABLE.has(feature) && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={testing !== null}
                        onClick={() => void test(feature)}
                        className="h-7 border-border px-2 text-[11px] text-muted-foreground hover:bg-muted"
                      >
                        {testing === feature ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : null}
                        {t('test')}
                      </Button>
                    )}
                    <Switch
                      checked={ownSwitch}
                      disabled={!canEdit || manual || saving === feature}
                      onCheckedChange={(checked) => void toggle(feature, checked)}
                      aria-label={t(`items.${feature}.name`)}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>

      {!canEdit && (
        <p className="px-1 text-xs text-muted-foreground">{t('adminOnly')}</p>
      )}
    </div>
  );
}
