'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { Search, UserRound, X } from 'lucide-react';
import type { PortalRecord } from './portal-types';
import { PrivateImage } from './private-image';
import { personCategories } from './access-panels';
const normalize = (value: unknown) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR');
function PersonPhoto({ person, allowed }: { person: PortalRecord; allowed: boolean }) {
  const [failed, setFailed] = useState(false);
  return allowed && person.directoryPhoto && !failed ? (
    <PrivateImage
      className="person-picker-photo"
      alt={'Foto de ' + person.name}
      src={'/api/people/' + encodeURIComponent(person.id) + '/photo'}
      onError={() => setFailed(true)}
    />
  ) : (
    <span className="person-picker-photo placeholder" aria-hidden="true">
      <UserRound size={23} />
    </span>
  );
}
export function PersonPicker({
  people,
  value,
  onChange,
  photos,
  disabled = false,
}: {
  people: PortalRecord[];
  value: string;
  onChange: (id: string) => void;
  photos: boolean;
  disabled?: boolean;
}) {
  const id = useId(),
    input = useRef<HTMLInputElement>(null),
    container = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState(''),
    [open, setOpen] = useState(false),
    [active, setActive] = useState(0);
  const search = normalize(query.trim()),
    selected = people.find((person) => person.id === value);
  const matches =
    search.length >= 2
      ? people
          .filter(
            (person) =>
              person.active !== false &&
              normalize(
                person.name + ' ' + (person.company ?? '') + ' ' + (person.documentLast4 ?? ''),
              ).includes(search),
          )
          .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
          .slice(0, 8)
      : [];
  const expanded = open && search.length >= 2,
    index = Math.min(active, Math.max(0, matches.length - 1));
  useEffect(() => {
    if (expanded)
      container.current
        ?.querySelector('[aria-selected="true"]')
        ?.scrollIntoView({ block: 'nearest' });
  }, [expanded, index]);
  function select(personId: string) {
    onChange(personId);
    setQuery('');
    setOpen(false);
    setActive(0);
    input.current?.focus();
  }
  return (
    <div
      className="person-picker full"
      ref={container}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <label className="field-label" htmlFor={id}>
        Buscar pessoa cadastrada
      </label>
      <div className="person-picker-input">
        <Search size={17} aria-hidden="true" />
        <input
          id={id}
          ref={input}
          className="input"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={expanded ? id + '-results' : undefined}
          aria-activedescendant={expanded && matches.length ? id + '-option-' + index : undefined}
          aria-describedby={id + '-hint'}
          autoComplete="off"
          placeholder="Nome, empresa ou final do documento…"
          value={query}
          disabled={disabled}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            if (value) onChange('');
            setQuery(event.target.value);
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              setOpen(true);
              setActive((current) =>
                Math.max(
                  0,
                  Math.min(matches.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)),
                ),
              );
            }
            if (event.key === 'Escape' && open) {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
            }
            if (event.key === 'Enter' && expanded) {
              event.preventDefault();
              if (matches[index]) select(matches[index].id);
            }
          }}
        />
        {(query || value) && (
          <button
            type="button"
            className="icon-button"
            aria-label="Limpar pessoa selecionada"
            disabled={disabled}
            onClick={() => select('')}
          >
            <X size={16} />
          </button>
        )}
      </div>
      <small id={id + '-hint'} className="field-hint">
        Digite pelo menos 2 caracteres. Para uma nova pessoa, preencha os campos abaixo.
      </small>
      {expanded && (
        <>
          <div
            role="listbox"
            id={id + '-results'}
            aria-label="Pessoas encontradas"
            className="person-picker-results"
          >
            {matches.map((person, i) => (
              <button
                type="button"
                role="option"
                tabIndex={-1}
                id={id + '-option-' + i}
                key={person.id}
                aria-selected={i === index}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => select(person.id)}
              >
                <PersonPhoto key={person.id} person={person} allowed={photos} />
                <span>
                  <strong>{person.name}</strong>
                  <small>
                    {person.company || 'Empresa não informada'} ·{' '}
                    {personCategories.find((category) => category.value === person.category)
                      ?.label || 'Pessoa cadastrada'}
                  </small>
                  <small>
                    {person.documentLast4 ? 'Documento final ' + person.documentLast4 + ' · ' : ''}
                    {person.directory ? 'Origem: iDSecure' : 'Origem: portal'}
                    {person.securityStatus === 'blocked' || person.directory?.blocked
                      ? ' · Bloqueado'
                      : ''}
                  </small>
                </span>
              </button>
            ))}
          </div>
          {!matches.length && (
            <p role="status" className="field-hint">
              Nenhum cadastro encontrado. Confira a busca ou preencha um novo cadastro.
            </p>
          )}
        </>
      )}
      {selected && (
        <div className="person-picker-selected" role="status">
          <PersonPhoto key={selected.id} person={selected} allowed={photos} />
          <div>
            <strong>{selected.name}</strong>
            <small>
              {selected.company || 'Empresa não informada'} ·{' '}
              {personCategories.find((category) => category.value === selected.category)?.label ||
                'Pessoa cadastrada'}
            </small>
            <small>Cadastro selecionado · dados preenchidos abaixo</small>
          </div>
        </div>
      )}
    </div>
  );
}
