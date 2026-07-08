const btn = document.getElementById("add");
const target = document.getElementById("injection-target");
const input = document.getElementById("custom-text");

btn.addEventListener("click", () => {
    const text = input.value.trim() || "新加入的中文內容應該被延遲標註，而且不要重複。";
    const p = document.createElement("p");
    p.className = "injected-node";
    p.textContent = text;
    target.prepend(p);
    input.value = '';
});