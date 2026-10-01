<script setup lang="ts">
/**
 * The survey console, at its own URL.
 *
 * Beside `/analyze/block` rather than inside it: the two read the same Figma
 * file through the same server, but one specifies a single block against a
 * ticket and the other indexes a whole project against nothing. Sharing a page
 * would mean a mode switch, and a mode switch is what makes a console hard to
 * link to.
 */
import FigmaSurveyConsole from '../../components/FigmaSurveyConsole.vue';

useHead({ title: 'Figma survey' });

const { arms } = useArms();
</script>

<template>
  <FigmaSurveyConsole :arms="arms" />
</template>
