<template>
  <section class="space-y-6">
    <header>
      <h1 class="text-2xl font-semibold tracking-tight">Jobs</h1>
      <p class="text-sm text-ink-500">Tạo job gen video, worker local sẽ nhận và chạy</p>
    </header>

    <SignInGate>
      <JobsPanel />
    </SignInGate>
  </section>
</template>

<script setup lang="ts">
useHead({ title: 'Jobs · AI Studio' });
</script>
