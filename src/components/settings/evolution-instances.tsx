'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  CheckCircle2,
  Loader2,
  Plus,
  QrCode,
  Smartphone,
  Star,
  Trash2,
  XCircle,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SettingsPanelHead } from './settings-panel-head';

/**
 * Settings → WhatsApp for the Evolution engine (CLAUDE.md §6.4).
 *
 * One card per connected number (whatsapp_config row with
 * engine='evolution'). "Add number" registers an instance on the
 * Evolution server and opens the QR dialog; the dialog polls
 * GET /api/whatsapp/evolution/instances/[id] every few seconds — each
 * poll returns a fresh QR (they rotate ~40s) until the phone scans it
 * and the state flips to "open".
 */

interface InstanceRow {
  id: string;
  display_name: string | null;
  evolution_instance_name: string;
  phone_number: string | null;
  status: string;
  is_default: boolean;
  connected_at: string | null;
  live_state: string | null;
}

const POLL_INTERVAL_MS = 4000;

export function EvolutionInstances() {
  const t = useTranslations('Settings.evolution');

  const [loading, setLoading] = useState(true);
  const [instances, setInstances] = useState<InstanceRow[]>([]);

  // Add-number dialog
  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);

  // QR dialog
  const [qrInstance, setQrInstance] = useState<InstanceRow | null>(null);
  const [qrBase64, setQrBase64] = useState<string | null>(null);
  const [qrState, setQrState] = useState<string>('connecting');
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const [removingId, setRemovingId] = useState<string | null>(null);

  const fetchInstances = useCallback(async () => {
    try {
      const res = await fetch('/api/whatsapp/evolution/instances');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setInstances(data.instances ?? []);
    } catch {
      toast.error(t('loadError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchInstances();
  }, [fetchInstances]);

  // ---- QR polling ------------------------------------------------

  const stopPolling = useCallback(() => {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  const pollOnce = useCallback(
    async (instanceId: string) => {
      try {
        const res = await fetch(`/api/whatsapp/evolution/instances/${instanceId}`);
        if (!res.ok) return;
        const data = await res.json();
        setQrState(data.state ?? 'unknown');
        if (data.qr_base64) setQrBase64(data.qr_base64);
        if (data.state === 'open') {
          stopPolling();
          toast.success(t('qrConnected'));
          setQrInstance(null);
          setQrBase64(null);
          fetchInstances();
        }
      } catch {
        // transient network error — next tick retries
      }
    },
    [fetchInstances, stopPolling, t],
  );

  const openQrDialog = useCallback(
    (instance: InstanceRow, initialQr: string | null) => {
      stopPolling();
      setQrInstance(instance);
      setQrBase64(initialQr);
      setQrState('connecting');
      pollOnce(instance.id);
      pollTimer.current = setInterval(() => pollOnce(instance.id), POLL_INTERVAL_MS);
    },
    [pollOnce, stopPolling],
  );

  // Clear the timer on unmount / dialog close.
  useEffect(() => stopPolling, [stopPolling]);

  // ---- Actions ---------------------------------------------------

  const handleCreate = async () => {
    setCreating(true);
    try {
      const res = await fetch('/api/whatsapp/evolution/instances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: newName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setAddOpen(false);
      setNewName('');
      await fetchInstances();
      toast.success(t('createSuccess'));
      openQrDialog(
        {
          ...(data.instance as InstanceRow),
          phone_number: null,
          connected_at: null,
          live_state: null,
        },
        data.qr_base64 ?? null,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : t('genericError');
      toast.error(message);
    } finally {
      setCreating(false);
    }
  };

  const handleRemove = async (instance: InstanceRow) => {
    if (!window.confirm(t('removeConfirm', { name: labelFor(instance) }))) return;
    setRemovingId(instance.id);
    try {
      const res = await fetch(`/api/whatsapp/evolution/instances/${instance.id}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      toast.success(t('removeSuccess'));
      fetchInstances();
    } catch (error) {
      const message = error instanceof Error ? error.message : t('genericError');
      toast.error(message);
    } finally {
      setRemovingId(null);
    }
  };

  // ---- Render ----------------------------------------------------

  const labelFor = (instance: InstanceRow) =>
    instance.display_name || instance.phone_number || instance.evolution_instance_name;

  const isConnected = (instance: InstanceRow) =>
    instance.live_state === 'open' ||
    (instance.live_state === null && instance.status === 'connected');

  return (
    <div>
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
        action={
          <Button onClick={() => setAddOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            {t('addNumber')}
          </Button>
        }
      />

      {loading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('loading')}
        </div>
      ) : instances.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <Smartphone className="h-8 w-8 text-muted-foreground" />
            <p className="max-w-[46ch] text-sm text-muted-foreground">{t('empty')}</p>
            <Button onClick={() => setAddOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              {t('addNumber')}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {instances.map((instance) => (
            <Card key={instance.id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-foreground">
                      {labelFor(instance)}
                    </span>
                    {instance.is_default ? (
                      <span
                        className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                        title={t('defaultHint')}
                      >
                        <Star className="h-3 w-3" />
                        {t('default')}
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-sm">
                    {isConnected(instance) ? (
                      <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                        <CheckCircle2 className="h-4 w-4" />
                        {t('connected')}
                        {instance.phone_number ? ` · +${instance.phone_number}` : ''}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-muted-foreground">
                        <XCircle className="h-4 w-4" />
                        {t('disconnected')}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {!isConnected(instance) ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => openQrDialog(instance, null)}
                    >
                      <QrCode className="mr-2 h-4 w-4" />
                      {t('connect')}
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={removingId === instance.id}
                    onClick={() => handleRemove(instance)}
                  >
                    {removingId === instance.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Add number */}
      <Dialog open={addOpen} onOpenChange={(open) => !creating && setAddOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('addDialogTitle')}</DialogTitle>
            <DialogDescription>{t('addDialogDesc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="evolution-display-name">{t('nameLabel')}</Label>
            <Input
              id="evolution-display-name"
              value={newName}
              placeholder={t('namePlaceholder')}
              onChange={(e) => setNewName(e.target.value)}
              disabled={creating}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)} disabled={creating}>
              {t('cancel')}
            </Button>
            <Button onClick={handleCreate} disabled={creating}>
              {creating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {t('create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* QR code */}
      <Dialog
        open={qrInstance !== null}
        onOpenChange={(open) => {
          if (!open) {
            stopPolling();
            setQrInstance(null);
            setQrBase64(null);
            fetchInstances();
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('qrTitle', { name: qrInstance ? labelFor(qrInstance) : '' })}
            </DialogTitle>
            <DialogDescription>{t('qrHint')}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col items-center gap-3 py-2">
            {qrBase64 ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={qrBase64}
                alt="QR code"
                className="h-64 w-64 rounded-md border border-border bg-white p-2"
              />
            ) : (
              <div className="flex h-64 w-64 items-center justify-center rounded-md border border-dashed border-border">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            )}
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {qrState === 'open' ? t('qrConnected') : t('qrWaiting')}
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
