import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  connectInstance,
  deleteInstance,
  fetchInstances,
  getConnectionState,
  logoutInstance,
} from '@/lib/whatsapp/evolution-api'
import { loadInstanceConn } from '@/lib/whatsapp/evolution-config'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'

/**
 * Single Evolution instance.
 *
 *   GET    /api/whatsapp/evolution/instances/[id]
 *     Connection state + a fresh QR code while disconnected. The
 *     Settings dialog polls this until the state flips to "open".
 *     When it does, we learn the connected phone number from the
 *     server and persist it (phone_number column).
 *
 *   DELETE /api/whatsapp/evolution/instances/[id]
 *     Logout + delete on the Evolution server, then remove the row
 *     (session client → RLS enforces account admin).
 */

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const loaded = await loadInstanceConn(supabase, id)
    if (!loaded.ok) {
      return NextResponse.json({ error: loaded.error }, { status: loaded.status })
    }

    const state = await getConnectionState(loaded.conn)

    if (state === 'open') {
      // Connected: learn the number (ownerJid) and persist it once.
      let phoneNumber = (loaded.row.phone_number as string | null) ?? null
      if (!phoneNumber) {
        try {
          const all = await fetchInstances({
            baseUrl: loaded.conn.baseUrl,
            apikey: loaded.conn.apikey,
          })
          const mine = all.find(
            (i) => i.instanceName === loaded.conn.instanceName
          )
          if (mine?.ownerJid) {
            phoneNumber = normalizePhone(mine.ownerJid.split('@')[0])
          }
        } catch {
          // best-effort; the webhook's connection.update also keeps
          // status fresh
        }
      }
      await supabase
        .from('whatsapp_config')
        .update({
          status: 'connected',
          connected_at:
            (loaded.row.connected_at as string | null) ?? new Date().toISOString(),
          ...(phoneNumber ? { phone_number: phoneNumber } : {}),
          updated_at: new Date().toISOString(),
        })
        .eq('id', id)

      return NextResponse.json({
        state,
        phone_number: phoneNumber,
        qr_base64: null,
        pairing_code: null,
      })
    }

    // Not connected: hand the UI a fresh QR (they expire every ~40s).
    let qrBase64: string | null = null
    let pairingCode: string | null = null
    try {
      const qr = await connectInstance(loaded.conn)
      qrBase64 = qr.qrBase64 ?? null
      pairingCode = qr.pairingCode ?? null
    } catch (error) {
      console.error('[evolution-instance] QR fetch failed:', error)
    }

    await supabase
      .from('whatsapp_config')
      .update({ status: 'disconnected', updated_at: new Date().toISOString() })
      .eq('id', id)

    return NextResponse.json({
      state,
      phone_number: (loaded.row.phone_number as string | null) ?? null,
      qr_base64: qrBase64,
      pairing_code: pairingCode,
    })
  } catch (error) {
    console.error('[evolution-instance] GET failed:', error)
    const message = error instanceof Error ? error.message : 'Internal error'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const loaded = await loadInstanceConn(supabase, id)
    if (!loaded.ok) {
      return NextResponse.json({ error: loaded.error }, { status: loaded.status })
    }

    // Tear down on the Evolution server first (both calls treat 404 as
    // already-gone), then drop the row.
    try {
      await logoutInstance(loaded.conn)
    } catch {
      // a dead session shouldn't block removal
    }
    await deleteInstance(loaded.conn)

    const { error: deleteError } = await supabase
      .from('whatsapp_config')
      .delete()
      .eq('id', id)
    if (deleteError) {
      const denied = deleteError.code === '42501'
      return NextResponse.json(
        { error: denied ? 'Only account admins can remove numbers' : deleteError.message },
        { status: denied ? 403 : 500 }
      )
    }

    return NextResponse.json({ deleted: true })
  } catch (error) {
    console.error('[evolution-instance] DELETE failed:', error)
    const message = error instanceof Error ? error.message : 'Internal error'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
