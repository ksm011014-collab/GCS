const THEME_STORAGE_KEY = "dss-theme";
const DEFAULT_THEME = "light";


function resolveTheme(theme) {
  return theme === "dark" ? "dark" : DEFAULT_THEME;
}


function applyTheme(theme) {
  const resolvedTheme = resolveTheme(theme);
  document.documentElement.dataset.theme = resolvedTheme;

  const themeSelect = document.getElementById("theme-select");
  if (themeSelect instanceof HTMLSelectElement) {
    themeSelect.value = resolvedTheme;
  }

  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, resolvedTheme);
  } catch (error) {
    console.warn("테마 설정을 저장하지 못했습니다.", error);
  }
}


export function initializeThemeSelector() {
  const themeSelect = document.getElementById("theme-select");
  let savedTheme = DEFAULT_THEME;

  try {
    savedTheme = window.localStorage.getItem(THEME_STORAGE_KEY) || DEFAULT_THEME;
  } catch (error) {
    console.warn("저장된 테마 설정을 불러오지 못했습니다.", error);
  }

  applyTheme(savedTheme);

  if (themeSelect instanceof HTMLSelectElement) {
    themeSelect.addEventListener("change", () => {
      applyTheme(themeSelect.value);
    });
  }
}
