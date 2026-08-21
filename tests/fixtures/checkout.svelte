<script lang="ts">
import { Eventra } from "@eventra_dev/eventra-sdk";

const tracker = new Eventra({ apiKey: "test" });

tracker.track("checkout.started");

function onSubmit() {
  tracker.track("checkout.submit");
}
</script>

<button type="button" event="checkout.cta" on:click={onSubmit}>
  Pay
</button>
