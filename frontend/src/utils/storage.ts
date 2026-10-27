// Браузерное хранилище только для удобств одного зрителя (тема, имя оператора); может быть недоступно
export function localStorageGet(key: string): string | null {
    try {
        return window.localStorage.getItem(key);
    } catch {
        return null;
    }
}

export function localStorageSet(key: string, value: string) {
    try {
        window.localStorage.setItem(key, value);
    } catch {
        /* хранилище недоступно - не страшно */
    }
}
