export default function UploadForm() {
  return (
    <form method="post" encType="multipart/form-data">
      <input type="file" name="file" />
      <button type="submit">Upload CSV</button>
    </form>
  );
}