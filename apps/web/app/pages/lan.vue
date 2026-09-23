<script setup lang="ts">
/**
 * LAN transfer: send files to another studio on the network, and collect what
 * others sent here.
 *
 * Both sides run the studio. The receiver turns its listener on and reads out an
 * address; the sender types it in and drops files. Uploads go to this studio on
 * loopback, which relays them to the peer as they stream.
 */
import { onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';

import { formatBytes } from '#shared/library';
import type { LanStatus } from '#shared/lan';

import UiAlert from '../components/ui/Alert.vue';
import UiBadge from '../components/ui/Badge.vue';
import UiButton from '../components/ui/Button.vue';
import UiCard from '../components/ui/Card.vue';
import UiField from '../components/ui/Field.vue';
import UiInput from '../components/ui/Input.vue';
import UiSectionTitle from '../components/ui/SectionTitle.vue';

useHead({ title: 'LAN transfer' });

const { data: status, refresh } = useAsyncData<LanStatus>('lan', () => $fetch('/api/lan'));

// ---- Receive --------------------------------------------------------------

const toggling = ref(false);
const listenError = ref<string | null>(null);

async function toggleListening() {
  toggling.value = true;
  listenError.value = null;
  try {
    status.value = await $fetch<LanStatus>('/api/lan/listen', {
      method: 'POST',
      body: { on: !status.value?.listening },
    });
  } catch (error) {
    listenError.value = describeFetchError(error);
  } finally {
    toggling.value = false;
  }
}

async function remove(name: string) {
  await $fetch('/api/lan/file', { method: 'DELETE', query: { name } });
  await refresh();
}

// The inbox fills from the other machine, so it is polled while it is open.
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  timer = setInterval(() => {
    if (status.value?.listening) void refresh();
  }, 3000);
});
onBeforeUnmount(() => clearInterval(timer));

// ---- Send -----------------------------------------------------------------

const PEER_KEY = 'aistudio.lan.peer';
const peer = ref('');
onMounted(() => {
  try {
    peer.value = localStorage.getItem(PEER_KEY) ?? '';
  } catch {
    /* storage unavailable: start empty */
  }
});
watch(peer, (value) => {
  try {
    localStorage.setItem(PEER_KEY, value);
  } catch {
    /* not worth surfacing */
  }
  peerCheck.value = null;
});

const peerCheck = ref<{ ok: boolean; label: string } | null>(null);
const checking = ref(false);

async function checkPeer() {
  checking.value = true;
  try {
    const found = await $fetch<{ hostname: string; host: string; port: number }>('/api/lan/peer', {
      query: { peer: peer.value },
    });
    peerCheck.value = { ok: true, label: `${found.hostname} (${found.host}:${found.port})` };
  } catch (error) {
    peerCheck.value = { ok: false, label: describeFetchError(error) };
  } finally {
    checking.value = false;
  }
}

interface Transfer {
  id: number;
  name: string;
  bytes: number;
  sent: number;
  state: 'queued' | 'sending' | 'done' | 'failed';
  detail?: string;
}

const transfers = reactive<Transfer[]>([]);
let nextId = 0;
const dragging = ref(false);
const picker = ref<HTMLInputElement | null>(null);

function sendOne(file: File, transfer: Transfer, to: string): Promise<void> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/lan/send?peer=${encodeURIComponent(to)}&name=${encodeURIComponent(file.name)}`);
    xhr.upload.onprogress = (event) => (transfer.sent = event.loaded);
    xhr.onload = () => {
      let body: { name?: string; data?: { message?: string } } = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* keep the status code */
      }
      if (xhr.status === 200) {
        transfer.state = 'done';
        transfer.sent = transfer.bytes;
        if (body.name && body.name !== file.name) transfer.detail = `saved as ${body.name}`;
      } else {
        transfer.state = 'failed';
        transfer.detail = body.data?.message ?? `failed (${xhr.status})`;
      }
      resolve();
    };
    xhr.onerror = () => {
      transfer.state = 'failed';
      transfer.detail = 'connection lost';
      resolve();
    };
    transfer.state = 'sending';
    xhr.send(file);
  });
}

async function send(files: File[]) {
  const to = peer.value.trim();
  if (!to || files.length === 0) return;

  const queued = files.map((file) => {
    const transfer: Transfer = { id: nextId++, name: file.name, bytes: file.size, sent: 0, state: 'queued' };
    transfers.unshift(transfer);
    // unshift copies into the reactive array; hold the proxied entry so progress renders.
    return { file, transfer: transfers[0]! };
  });
  // One at a time: parallel sends would only split the same link between them.
  for (const { file, transfer } of queued) await sendOne(file, transfer, to);
}

function onPick(event: Event) {
  const input = event.target as HTMLInputElement;
  void send([...(input.files ?? [])]);
  input.value = '';
}

function onDrop(event: DragEvent) {
  dragging.value = false;
  void send([...(event.dataTransfer?.files ?? [])]);
}

const STATE_TONE = { queued: 'neutral', sending: 'accent', done: 'ok', failed: 'bad' } as const;
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="mx-auto max-w-5xl space-y-8 p-8">
      <header class="space-y-1">
        <h1 class="text-2xl font-semibold">LAN transfer</h1>
        <p class="text-sm text-slate-400">
          Move files between two machines running the studio on the same network. No account, no cloud: the
          receiver opens its inbox, the sender types its address.
        </p>
      </header>

      <div class="grid gap-6 lg:grid-cols-2">
        <!-- Send -->
        <UiCard>
          <div class="space-y-4 p-5">
            <UiSectionTitle title="Send" subtitle="To another machine whose inbox is open." />

            <UiField label="Receiver address" for="lan-peer" hint="As its LAN page shows it, e.g. 192.168.1.20:3001">
              <div class="flex gap-2">
                <UiInput id="lan-peer" v-model="peer" placeholder="192.168.1.20:3001" />
                <UiButton :disabled="!peer.trim() || checking" @click="checkPeer">
                  {{ checking ? 'Checking…' : 'Check' }}
                </UiButton>
              </div>
            </UiField>
            <UiAlert v-if="peerCheck" :tone="peerCheck.ok ? 'success' : 'error'">
              {{ peerCheck.ok ? `Reachable: ${peerCheck.label}` : peerCheck.label }}
            </UiAlert>

            <div
              class="cursor-pointer rounded-lg border-2 border-dashed p-8 text-center text-sm transition-colors"
              :class="[
                dragging ? 'border-indigo-400 bg-indigo-500/10' : 'border-white/15 hover:border-white/30',
                peer.trim() ? 'text-slate-300' : 'pointer-events-none text-slate-500 opacity-50',
              ]"
              @click="picker?.click()"
              @dragover.prevent="dragging = true"
              @dragleave="dragging = false"
              @drop.prevent="onDrop"
            >
              Drop files here, or click to browse
              <input ref="picker" type="file" multiple hidden @change="onPick" />
            </div>

            <ul v-if="transfers.length" class="space-y-2">
              <li v-for="transfer in transfers" :key="transfer.id" class="space-y-1 text-sm">
                <div class="flex items-center justify-between gap-3">
                  <span class="truncate">{{ transfer.name }}</span>
                  <UiBadge :tone="STATE_TONE[transfer.state]">{{ transfer.state }}</UiBadge>
                </div>
                <div class="h-1.5 overflow-hidden rounded bg-white/10">
                  <div
                    class="h-full transition-[width]"
                    :class="transfer.state === 'failed' ? 'bg-rose-500' : 'bg-indigo-400'"
                    :style="{ width: `${transfer.bytes ? (transfer.sent / transfer.bytes) * 100 : 100}%` }"
                  />
                </div>
                <p class="text-xs text-slate-500">
                  {{ formatBytes(transfer.sent) }} / {{ formatBytes(transfer.bytes) }}
                  <span v-if="transfer.detail"> · {{ transfer.detail }}</span>
                </p>
              </li>
            </ul>
          </div>
        </UiCard>

        <!-- Receive -->
        <UiCard>
          <div class="space-y-4 p-5">
            <UiSectionTitle title="Receive" subtitle="Files sent to this machine.">
              <template #actions>
                <UiButton
                  :variant="status?.listening ? 'danger' : 'primary'"
                  :disabled="toggling"
                  @click="toggleListening"
                >
                  {{ status?.listening ? 'Stop receiving' : 'Start receiving' }}
                </UiButton>
              </template>
            </UiSectionTitle>

            <UiAlert v-if="listenError" tone="error">{{ listenError }}</UiAlert>

            <UiAlert v-if="status?.listening" tone="success" title="Inbox open. Give the sender one of:">
              <ul class="mt-1 font-mono">
                <li v-for="address in status.addresses" :key="address">{{ address }}:{{ status.port }}</li>
              </ul>
              <p class="mt-2 text-xs opacity-80">
                Anyone on this network can drop files here while it is open. Windows may ask to allow Node through
                the firewall the first time.
              </p>
            </UiAlert>
            <p v-else class="text-sm text-slate-400">
              Closed. {{ status?.hostname }} is not reachable from the network until you start receiving.
            </p>

            <ul v-if="status?.inbox.length" class="divide-y divide-white/10 rounded border border-white/10">
              <li
                v-for="file in status.inbox"
                :key="file.name"
                class="flex items-center justify-between gap-3 px-3 py-2 text-sm"
              >
                <div class="min-w-0">
                  <p class="truncate">{{ file.name }}</p>
                  <p class="text-xs text-slate-500">
                    {{ formatBytes(file.bytes) }} · {{ new Date(file.receivedAt).toLocaleString() }}
                  </p>
                </div>
                <div class="flex shrink-0 gap-1">
                  <a
                    :href="`/api/lan/file?name=${encodeURIComponent(file.name)}`"
                    download
                    class="rounded px-2 py-1 text-xs text-indigo-300 hover:bg-white/5"
                  >
                    Download
                  </a>
                  <UiButton variant="ghost" size="sm" @click="remove(file.name)">Delete</UiButton>
                </div>
              </li>
            </ul>
            <p v-else class="text-sm text-slate-500">Nothing received yet.</p>
          </div>
        </UiCard>
      </div>
    </div>
  </div>
</template>
