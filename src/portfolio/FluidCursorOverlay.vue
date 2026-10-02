<script setup lang="ts">
import FluidCursor from "@/components/ui/fluid-cursor/FluidCursor.vue";
</script>

<template>
  <FluidCursor
    :density-dissipation="3.5"
    :velocity-dissipation="2"
    :pressure="0.1"
    :curl="3"
    :splat-radius="0.2"
    :splat-force="6000"
    :transparent="true"
    aria-hidden="true"
    class="portfolio-fluid-cursor"
  />
</template>
