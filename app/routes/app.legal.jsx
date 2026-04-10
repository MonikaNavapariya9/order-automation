export default function Legal() {
  return (
    <form method="post">
      <h2>Legal Form</h2>

      <input name="name" placeholder="Full Name" required />
      <input name="address" placeholder="Address" required />

      <label>
        <input type="checkbox" required />
        Accept Terms
      </label>

      <button type="submit">Continue</button>
    </form>
  );
}