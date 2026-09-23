<script setup lang="ts">
/**
 * The requirements console, at its own URL.
 *
 * Like every other view here it renders on the server first and has a link of
 * its own, rather than being a mode of some other page.
 */
import AnalyzeConsole from '../../components/AnalyzeConsole.vue';

useHead({ title: 'Analyze' });

const { arms } = useArms();
</script>

<template>
  <AnalyzeConsole :arms="arms" />
</template>
