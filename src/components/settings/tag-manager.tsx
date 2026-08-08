'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  ArrowDown,
  ArrowUp,
  Filter,
  Loader2,
  Plus,
  Tag as TagIcon,
  X,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { useTranslations } from 'next-intl';
import type { Tag } from '@/types';

const PRESET_COLORS = [
  { name: 'red', value: '#ef4444' },
  { name: 'orange', value: '#f97316' },
  { name: 'amber', value: '#f59e0b' },
  { name: 'emerald', value: '#10b981' },
  { name: 'cyan', value: '#06b6d4' },
  { name: 'blue', value: '#3b82f6' },
  { name: 'violet', value: '#8b5cf6' },
  { name: 'pink', value: '#ec4899' },
];

/**
 * Tags card — colour-coded contact labels. Creation is an inline row
 * (name + colour swatch + Add); deletion goes through a confirmation
 * dialog since it detaches the tag from every contact.
 */
export function TagManager() {
  const t = useTranslations('Settings.tagsAndFields');
  const supabase = createClient();
  const { user, accountId, loading: authLoading } = useAuth();

  const [loading, setLoading] = useState(true);
  const [tags, setTags] = useState<Tag[]>([]);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [tagToDelete, setTagToDelete] = useState<Tag | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [selectedColor, setSelectedColor] = useState(PRESET_COLORS[3].value);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setLoading(false);
      return;
    }
    fetchTags(user.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, user?.id]);

  async function fetchTags(userId: string) {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('tags')
        .select('*')
        .eq('user_id', userId)
        // Mesma ordem dos chips do inbox (046) — o que se vê aqui é o
        // funil de verdade, na sequência em que ele aparece lá.
        .order('funnel_position', { ascending: true })
        .order('created_at', { ascending: true });

      if (error) throw error;
      setTags(data || []);
    } catch (err) {
      console.error('Failed to fetch tags:', err);
      toast.error(t('failedToLoadTags'));
    } finally {
      setLoading(false);
    }
  }

  /** Liga/desliga a etiqueta como estágio do funil (chip no inbox). */
  async function toggleFunnel(tag: Tag) {
    const next = !tag.is_funnel_stage;
    // Entrando no funil, vai para o fim da fila.
    const position = next
      ? Math.max(0, ...tags.map((t) => t.funnel_position ?? 0)) + 10
      : 0;
    setTags((prev) =>
      prev.map((t) =>
        t.id === tag.id
          ? { ...t, is_funnel_stage: next, funnel_position: position }
          : t,
      ),
    );
    const { error } = await supabase
      .from('tags')
      .update({ is_funnel_stage: next, funnel_position: position })
      .eq('id', tag.id);
    if (error) {
      toast.error(t('funnelFailed'));
      if (user) void fetchTags(user.id);
      return;
    }
    toast.success(next ? t('funnelAdded') : t('funnelRemoved'));
  }

  /** Troca a etiqueta de lugar com a vizinha (ordem dos chips). */
  async function moveFunnel(tag: Tag, direction: -1 | 1) {
    const index = tags.findIndex((t) => t.id === tag.id);
    const target = tags[index + direction];
    if (!target) return;

    const reordered = [...tags];
    [reordered[index], reordered[index + direction]] = [
      reordered[index + direction],
      reordered[index],
    ];
    // Reescreve as posições em passos de 10 — sobra espaço para
    // inserções futuras sem renumerar tudo.
    const withPositions = reordered.map((t, i) => ({
      ...t,
      funnel_position: (i + 1) * 10,
    }));
    setTags(withPositions);

    const updates = withPositions
      .filter((t) => t.is_funnel_stage)
      .map((t) =>
        supabase
          .from('tags')
          .update({ funnel_position: t.funnel_position })
          .eq('id', t.id),
      );
    const results = await Promise.all(updates);
    if (results.some((r) => r.error)) {
      toast.error(t('funnelFailed'));
      if (user) void fetchTags(user.id);
    }
  }

  async function handleCreate() {
    if (!newTagName.trim()) {
      toast.error(t('nameRequired'));
      return;
    }

    try {
      setSaving(true);
      if (!user || !accountId) {
        toast.error(t('notAuthenticated'));
        return;
      }

      // account_id is mandatory on every account-scoped insert (NOT
      // NULL + RLS, no DB default).
      const { error } = await supabase.from('tags').insert({
        user_id: user.id,
        account_id: accountId,
        name: newTagName.trim(),
        color: selectedColor,
      });

      if (error) throw error;

      toast.success(t('tagCreated'));
      setNewTagName('');
      setSelectedColor(PRESET_COLORS[3].value);
      await fetchTags(user.id);
    } catch (err) {
      console.error('Create error:', err);
      toast.error(t('failedToCreateTag'));
    } finally {
      setSaving(false);
    }
  }

  function confirmDelete(tag: Tag) {
    setTagToDelete(tag);
    setDeleteDialogOpen(true);
  }

  async function handleDelete() {
    if (!tagToDelete) return;

    try {
      setDeleting(true);
      const { error } = await supabase
        .from('tags')
        .delete()
        .eq('id', tagToDelete.id);

      if (error) throw error;

      toast.success(t('tagDeleted'));
      setTags((prev) => prev.filter((t) => t.id !== tagToDelete.id));
      setDeleteDialogOpen(false);
      setTagToDelete(null);
    } catch (err) {
      console.error('Delete error:', err);
      toast.error(t('failedToDeleteTag'));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <TagIcon className="size-4 text-primary" />
          {t('tagsTitle')}
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          {t('tagsDesc')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-6 animate-spin text-primary" />
          </div>
        ) : (
          <>
            {tags.length > 0 ? (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {tags.map((tag, index) => (
                  <li
                    key={tag.id}
                    className="flex items-center gap-2 px-3 py-2"
                  >
                    <span
                      className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium"
                      style={{
                        backgroundColor: `${tag.color}20`,
                        color: tag.color,
                        border: `1px solid ${tag.color}40`,
                      }}
                    >
                      <span
                        className="size-2 rounded-full"
                        style={{ backgroundColor: tag.color }}
                      />
                      {tag.name}
                    </span>

                    <div className="ml-auto flex items-center gap-1">
                      {/* Estágio de funil: vira chip com contador no inbox (046). */}
                      <button
                        type="button"
                        onClick={() => void toggleFunnel(tag)}
                        title={
                          tag.is_funnel_stage
                            ? t('funnelRemove')
                            : t('funnelAdd')
                        }
                        aria-pressed={tag.is_funnel_stage ?? false}
                        className={cn(
                          'flex h-7 items-center gap-1 rounded-md px-2 text-[11px] transition-colors',
                          tag.is_funnel_stage
                            ? 'bg-primary-soft text-primary'
                            : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                        )}
                      >
                        <Filter className="size-3" />
                        {t('funnelChip')}
                      </button>

                      {tag.is_funnel_stage && (
                        <>
                          <button
                            type="button"
                            onClick={() => void moveFunnel(tag, -1)}
                            disabled={index === 0}
                            aria-label={t('moveUp')}
                            className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted disabled:opacity-30"
                          >
                            <ArrowUp className="size-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void moveFunnel(tag, 1)}
                            disabled={index === tags.length - 1}
                            aria-label={t('moveDown')}
                            className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted disabled:opacity-30"
                          >
                            <ArrowDown className="size-3.5" />
                          </button>
                        </>
                      )}

                      <button
                        type="button"
                        onClick={() => confirmDelete(tag)}
                        aria-label={t('deleteAria', { name: tag.name })}
                        className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-red-400"
                      >
                        <X className="size-3.5" />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t('noTags')}
              </p>
            )}

            {/* Inline create row */}
            <div className="flex flex-wrap items-center gap-2.5">
              <Input
                placeholder={t('placeholder')}
                value={newTagName}
                onChange={(e) => setNewTagName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreate();
                }}
                disabled={saving}
                maxLength={40}
                className="min-w-[180px] flex-1"
              />
              <div className="flex gap-1.5">
                {PRESET_COLORS.map((color) => (
                  <button
                    key={color.value}
                    type="button"
                    onClick={() => setSelectedColor(color.value)}
                    aria-label={t('useColor', { color: t(`colors.${color.name}` as Parameters<typeof t>[0]) })}
                    aria-pressed={selectedColor === color.value}
                    className={cn(
                      'size-6 rounded-md transition-transform hover:scale-110',
                      selectedColor === color.value &&
                        'outline outline-2 outline-offset-2 outline-primary',
                    )}
                    style={{ backgroundColor: color.value }}
                    title={t(`colors.${color.name}` as Parameters<typeof t>[0])}
                  />
                ))}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleCreate}
                disabled={saving || !newTagName.trim()}
              >
                {saving ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Plus className="size-4" />
                )}
                {t('addTag')}
              </Button>
            </div>
          </>
        )}
      </CardContent>

      {/* Delete confirmation */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('deleteTag')}</DialogTitle>
            <DialogDescription>
              {tagToDelete ? t('deleteConfirm', { name: tagToDelete.name }) : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setDeleteDialogOpen(false)}
              disabled={deleting}
            >
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('deleting')}
                </>
              ) : (
                t('deleteTag')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
