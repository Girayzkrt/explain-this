import { initializeStorageAccess } from "../platform/storage/storage-area";

export default defineBackground(() => {
  void initializeStorageAccess();
});
