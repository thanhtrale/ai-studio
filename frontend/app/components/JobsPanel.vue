<template>
  <div class="space-y-6">
    <div class="flex items-center gap-3">
      <span
        class="rounded-full px-3 py-1 text-xs"
        :class="workerOnline ? 'bg-emerald-400/15 text-emerald-300' : 'bg-white/10 text-ink-500'"
      >
        Worker: {{ workerOnline ? 'online' : 'offline' }}
      </span>
      <span v-if="error" class="text-sm text-red-300">{{ error }}</span>
    </div>

    <JobCreateForm :worker-online="workerOnline" :submit="submit" />
    <JobList :jobs="jobs" :pending="pending" :cancel="cancel" :remove="remove" />
  </div>
</template>

<script setup lang="ts">
const { jobs, workerOnline, error, pending, submit, cancel, remove } = useCloudJobs();
</script>
