// The speaker script as one self-contained file, for the meeting sites added on
// the options page. The manifest's copy loads its code from the extension as
// web-accessible resources, which Chrome only serves to the hosts the manifest
// names; this bundle needs none, so it runs on any host it's registered for.
import { onExecute } from './index';

onExecute();
