'use client';

// Settings → Scripts (FASE 3, §8): CRUD das sequências de mensagens que
// substituem os "scripts" da WA Scale. Um script tem itens ordenados
// (texto ou mídia do bucket chat-media), pausa natural entre eles e
// variáveis {{nome}}/{{primeiro_nome}}/{{telefone}}. O disparo em si
// acontece no composer do inbox (botão Scripts → 1 toque).

import { useCallback, useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  ArrowDown,
  ArrowUp,
  Clapperboard,
  FileText,
  Film,
  Image as ImageIcon,
  Loader2,
  Mic,
  Plus,
  Trash2,
  Upload,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  uploadAccountMedia,
  MEDIA_MAX_BYTES_BY_KIND,
} from '@/lib/storage/upload-media';
import { CHAT_MEDIA_BUCKET } from '@/components/inbox/message-composer';

type ItemType = 'text' | 'image' | 'video' | 'document' | 'audio';

const ITEM_TYPE_ICONS: Record<ItemType, typeof FileText> = {
  text: FileText,
  image: ImageIcon,
  video: Film,
  document: FileText,
  audio: Mic,
};

const VARIABLES = ['{{nome}}', '{{primeiro_nome}}', '{{telefone}}'] as const;

interface ScriptRow {
  id: string;
  name: string;
  description: string | null;
  item_count?: number;
}

interface DraftItem {
  /** id existente no banco, ou null para item novo. */
  id: string | null;
  item_type: ItemType;
  content_text: string;
  media_url: string | null;
  media_path: string | null;
  filename: string | null;
  delay_seconds: number;
}

const BLANK_ITEM: DraftItem = {
  id: null,
  item_type: 'text',
  content_text: '',
  media_url: null,
  media_path: null,
  filename: null,
  delay_seconds: 4,
};

export function ScriptsManager() {
  const t = useTranslations('Settings.scripts');
  const supabase = createClient();
  const { accountId } = useAuth();

  const [scripts, setScripts] = useState<ScriptRow[]>([]);
  const [loading, setLoading] = useState(true);

  // Editor dialog state.
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [items, setItems] = useState<DraftItem[]>([{ ...BLANK_ITEM }]);
  const [saving, setSaving] = useState(false);
  const [uploadingIndex, setUploadingIndex] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingUploadIndex = useRef<number>(0);

  // Exclusão.
  const [deleteTarget, setDeleteTarget] = useState<ScriptRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchScripts = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('message_scripts')
      .select('id, name, description, message_script_items(count)')
      .order('name');
    if (error) {
      toast.error(t('loadFailed'));
    } else {
      setScripts(
        (data ?? []).map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          item_count: Array.isArray(s.message_script_items)
            ? ((s.message_script_items[0] as { count?: number })?.count ?? 0)
            : 0,
        })),
      );
    }
    setLoading(false);
  }, [supabase, t]);

  useEffect(() => {
    void fetchScripts();
  }, [fetchScripts]);

  function openNew() {
    setEditingId(null);
    setName('');
    setDescription('');
    setItems([{ ...BLANK_ITEM }]);
    setEditorOpen(true);
  }

  async function openEdit(script: ScriptRow) {
    setEditingId(script.id);
    setName(script.name);
    setDescription(script.description ?? '');
    const { data, error } = await supabase
      .from('message_script_items')
      .select('*')
      .eq('script_id', script.id)
      .order('position');
    if (error) {
      toast.error(t('loadFailed'));
      return;
    }
    setItems(
      (data ?? []).map((i) => ({
        id: i.id,
        item_type: i.item_type as ItemType,
        content_text: i.content_text ?? '',
        media_url: i.media_url,
        media_path: i.media_path,
        filename: i.filename,
        delay_seconds: i.delay_seconds ?? 4,
      })),
    );
    setEditorOpen(true);
  }

  function updateItem(index: number, patch: Partial<DraftItem>) {
    setItems((prev) =>
      prev.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    );
  }

  function moveItem(index: number, dir: -1 | 1) {
    setItems((prev) => {
      const next = [...prev];
      const target = index + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function removeItem(index: number) {
    setItems((prev) => prev.filter((_, i) => i !== index));
  }

  function pickMedia(index: number) {
    pendingUploadIndex.current = index;
    fileInputRef.current?.click();
  }

  async function handleFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const index = pendingUploadIndex.current;
    const kind = items[index]?.item_type;
    if (!kind || kind === 'text') return;

    const max = MEDIA_MAX_BYTES_BY_KIND[kind];
    if (max && file.size > max) {
      toast.error(
        t('fileTooLarge', { mb: Math.round(max / 1024 / 1024) }),
      );
      return;
    }

    setUploadingIndex(index);
    try {
      const { publicUrl, path } = await uploadAccountMedia(
        CHAT_MEDIA_BUCKET,
        file,
      );
      updateItem(index, {
        media_url: publicUrl,
        media_path: path,
        filename: file.name,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('uploadFailed'));
    } finally {
      setUploadingIndex(null);
    }
  }

  function validate(): string | null {
    if (!name.trim()) return t('validateName');
    if (items.length === 0) return t('validateItems');
    for (const [i, item] of items.entries()) {
      if (item.item_type === 'text' && !item.content_text.trim()) {
        return t('validateTextItem', { n: i + 1 });
      }
      if (item.item_type !== 'text' && !item.media_url) {
        return t('validateMediaItem', { n: i + 1 });
      }
    }
    return null;
  }

  async function handleSave() {
    const problem = validate();
    if (problem) {
      toast.error(problem);
      return;
    }
    if (!accountId) return;
    setSaving(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const userId = session?.user?.id;
      if (!userId) throw new Error(t('notSignedIn'));

      let scriptId = editingId;
      if (scriptId) {
        const { error } = await supabase
          .from('message_scripts')
          .update({ name: name.trim(), description: description.trim() || null })
          .eq('id', scriptId);
        if (error) throw new Error(error.message);
        // Regrava os itens do zero — mantém a ordem simples e correta.
        const { error: delErr } = await supabase
          .from('message_script_items')
          .delete()
          .eq('script_id', scriptId);
        if (delErr) throw new Error(delErr.message);
      } else {
        const { data, error } = await supabase
          .from('message_scripts')
          .insert({
            account_id: accountId,
            created_by: userId,
            name: name.trim(),
            description: description.trim() || null,
          })
          .select('id')
          .single();
        if (error || !data) throw new Error(error?.message ?? 'insert failed');
        scriptId = data.id;
      }

      const rows = items.map((item, i) => ({
        script_id: scriptId,
        position: i + 1,
        item_type: item.item_type,
        content_text: item.content_text.trim() || null,
        media_url: item.item_type === 'text' ? null : item.media_url,
        media_path: item.item_type === 'text' ? null : item.media_path,
        filename: item.item_type === 'text' ? null : item.filename,
        delay_seconds: item.delay_seconds,
      }));
      const { error: itemsErr } = await supabase
        .from('message_script_items')
        .insert(rows);
      if (itemsErr) throw new Error(itemsErr.message);

      toast.success(editingId ? t('toastUpdated') : t('toastCreated'));
      setEditorOpen(false);
      void fetchScripts();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    const { error } = await supabase
      .from('message_scripts')
      .delete()
      .eq('id', deleteTarget.id);
    setDeleting(false);
    if (error) {
      toast.error(t('deleteFailed'));
      return;
    }
    toast.success(t('toastDeleted'));
    setDeleteTarget(null);
    void fetchScripts();
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Clapperboard className="h-4 w-4 text-primary" /> {t('title')}
            </CardTitle>
            <CardDescription>{t('description')}</CardDescription>
          </div>
          <Button
            size="sm"
            onClick={openNew}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" /> {t('newScript')}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : scripts.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
            <Clapperboard className="h-8 w-8 opacity-40" />
            <p>{t('empty')}</p>
            <p className="text-xs">{t('emptyHint')}</p>
          </div>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {scripts.map((script) => (
              <li
                key={script.id}
                className="flex items-center justify-between gap-3 px-3 py-2.5"
              >
                <button
                  type="button"
                  onClick={() => void openEdit(script)}
                  className="min-w-0 flex-1 text-left"
                >
                  <p className="truncate text-sm font-medium text-foreground">
                    {script.name}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {t('itemCount', { n: script.item_count ?? 0 })}
                    {script.description ? ` — ${script.description}` : ''}
                  </p>
                </button>
                <button
                  type="button"
                  onClick={() => setDeleteTarget(script)}
                  aria-label={t('delete')}
                  className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-red-400"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      {/* Editor */}
      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="bg-popover border-border max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {editingId ? t('editTitle') : t('newTitle')}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-muted-foreground">{t('nameLabel')}</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('namePlaceholder')}
                  className="bg-muted border-border text-foreground"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-muted-foreground">
                  {t('descriptionLabel')}
                </Label>
                <Input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={t('descriptionPlaceholder')}
                  className="bg-muted border-border text-foreground"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {t('variablesHint')}
              {VARIABLES.map((v) => (
                <code
                  key={v}
                  className="rounded bg-muted px-1.5 py-0.5 font-mono text-primary"
                >
                  {v}
                </code>
              ))}
            </div>

            <div className="space-y-3">
              {items.map((item, index) => {
                const Icon = ITEM_TYPE_ICONS[item.item_type];
                return (
                  <div
                    key={index}
                    className="space-y-2 rounded-lg border border-border bg-card p-3"
                  >
                    <div className="flex items-center gap-2">
                      <Icon className="h-4 w-4 shrink-0 text-primary" />
                      <span className="text-xs font-medium text-muted-foreground">
                        {t('itemLabel', { n: index + 1 })}
                      </span>
                      <div className="ml-auto flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => moveItem(index, -1)}
                          disabled={index === 0}
                          aria-label={t('moveUp')}
                          className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted disabled:opacity-30"
                        >
                          <ArrowUp className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => moveItem(index, 1)}
                          disabled={index === items.length - 1}
                          aria-label={t('moveDown')}
                          className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted disabled:opacity-30"
                        >
                          <ArrowDown className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => removeItem(index)}
                          aria-label={t('removeItem')}
                          className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-red-400"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>

                    <div className="grid gap-2 sm:grid-cols-[10rem_1fr_7rem]">
                      <Select
                        value={item.item_type}
                        onValueChange={(v) =>
                          updateItem(index, {
                            item_type: v as ItemType,
                            media_url: null,
                            media_path: null,
                            filename: null,
                          })
                        }
                      >
                        <SelectTrigger className="bg-muted border-border">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(['text', 'image', 'video', 'document', 'audio'] as const).map(
                            (type) => (
                              <SelectItem key={type} value={type}>
                                {t(`types.${type}`)}
                              </SelectItem>
                            ),
                          )}
                        </SelectContent>
                      </Select>

                      <div className="space-y-2">
                        {item.item_type !== 'text' && (
                          <div className="flex items-center gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => pickMedia(index)}
                              disabled={uploadingIndex === index}
                              className="border-border text-muted-foreground hover:bg-muted"
                            >
                              {uploadingIndex === index ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Upload className="h-4 w-4" />
                              )}
                              {item.media_url ? t('replaceFile') : t('chooseFile')}
                            </Button>
                            {item.filename && (
                              <span className="truncate text-xs text-muted-foreground">
                                {item.filename}
                              </span>
                            )}
                          </div>
                        )}
                        <Textarea
                          value={item.content_text}
                          onChange={(e) =>
                            updateItem(index, { content_text: e.target.value })
                          }
                          placeholder={
                            item.item_type === 'text'
                              ? t('textPlaceholder')
                              : t('captionPlaceholder')
                          }
                          rows={2}
                          className="bg-muted border-border text-foreground"
                        />
                      </div>

                      <div className="space-y-1">
                        <Label className="text-[10px] uppercase text-muted-foreground">
                          {t('delayLabel')}
                        </Label>
                        <Input
                          type="number"
                          min={0}
                          max={300}
                          value={item.delay_seconds}
                          onChange={(e) =>
                            updateItem(index, {
                              delay_seconds: Math.max(
                                0,
                                Math.min(300, Number(e.target.value) || 0),
                              ),
                            })
                          }
                          className="bg-muted border-border text-foreground"
                        />
                      </div>
                    </div>
                  </div>
                );
              })}

              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setItems((prev) => [...prev, { ...BLANK_ITEM }])}
                className="border-border text-muted-foreground hover:bg-muted"
              >
                <Plus className="h-4 w-4" /> {t('addItem')}
              </Button>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEditorOpen(false)}
              disabled={saving}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button
              onClick={() => void handleSave()}
              disabled={saving}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirmação de exclusão */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent className="bg-popover border-border sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {t('deleteTitle', { name: deleteTarget?.name ?? '' })}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{t('deleteDesc')}</p>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button
              onClick={() => void handleDelete()}
              disabled={deleting}
              className="bg-red-600 text-white hover:bg-red-700"
            >
              {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t('delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={(e) => void handleFilePicked(e)}
      />
    </Card>
  );
}
