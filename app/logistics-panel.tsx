'use client';

import { Camera, FileText, Gauge, LogIn, LogOut, Package, Plus, Search, Truck } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { canWithCapabilities as allowed, capability } from '../lib/access.mjs';
import IncidentMedia from './incident-media';
import type { PortState, User } from './portal-shared';
import { Button, DataTable, EmptyState, FormField, ModalFrame, StatusBadge } from './ui';
import './logistics.css';

type FleetVehicle = {
  id: string;
  plate: string;
  name: string;
  ownership?: string;
  active: boolean;
  initialOdometerKm?: number;
  currentOdometerKm?: number;
  notes?: string;
};
type FleetTrip = {
  id: string;
  fleetId: string;
  plate: string;
  vehicleName: string;
  driver: string;
  destination: string;
  purpose: string;
  odometerOut: number;
  odometerIn: number | null;
  distanceKm: number | null;
  conditionOut: string;
  conditionIn: string;
  departedAt: string;
  returnedAt: string | null;
  status: 'out' | 'returned';
  createdBy: string;
  updatedBy: string;
};
type MaterialExit = {
  id: string;
  description: string;
  quantity: string;
  destination: string;
  responsible: string;
  invoiceNumber?: string;
  vehiclePlate?: string;
  notes?: string;
  createdAt: string;
  createdBy: string;
};
type Editor =
  | { kind: 'vehicle' }
  | { kind: 'depart'; vehicle?: FleetVehicle }
  | { kind: 'return'; trip: FleetTrip }
  | { kind: 'material' };
type Props = {
  mode: 'fleet' | 'materials';
  state: PortState;
  user: User;
  run: (type: string, payload: Record<string, unknown>) => Promise<unknown>;
  reload: () => Promise<void>;
};
const km = (value: number | null | undefined) =>
  value == null ? '—' : new Intl.NumberFormat('pt-BR').format(value) + ' km';
const normalize = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

export function LogisticsPanel({ mode, state, user, run, reload }: Props) {
  const [query, setQuery] = useState(''),
    [editor, setEditor] = useState<Editor | null>(null),
    [tripId, setTripId] = useState<string | null>(null),
    [materialId, setMaterialId] = useState<string | null>(null),
    [phase, setPhase] = useState<'departure' | 'return'>('departure'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const data = state as unknown as {
      fleet: FleetVehicle[];
      fleetTrips?: FleetTrip[];
      materialExits?: MaterialExit[];
    },
    vehicles = (data.fleet ?? []).filter((v) => v.ownership === 'company'),
    trips = data.fleetTrips ?? [],
    materials = data.materialExits ?? [],
    out = trips.filter((trip) => trip.status === 'out'),
    available = vehicles.filter(
      (vehicle) => vehicle.active && !out.some((t) => t.fleetId === vehicle.id),
    ),
    term = normalize(query),
    matches = (...values: (string | undefined)[]) =>
      !term || normalize(values.filter(Boolean).join(' ')).includes(term),
    shownVehicles = vehicles.filter((v) => matches(v.plate, v.name)),
    shownTrips = trips.filter((t) => matches(t.plate, t.vehicleName, t.driver, t.destination)),
    shownMaterials = materials.filter((m) =>
      matches(m.description, m.invoiceNumber, m.destination, m.responsible, m.vehiclePlate),
    ),
    trip = trips.find((item) => item.id === tripId),
    material = materials.find((item) => item.id === materialId),
    canDepart = allowed(user, 'FLEET_DEPART'),
    canReturn = allowed(user, 'FLEET_RETURN'),
    canSaveVehicle = allowed(user, 'FLEET_VEHICLE_SAVE'),
    canMaterial = allowed(user, 'MATERIAL_EXIT_CREATE');
  const date = (value: string | null | undefined) =>
    value
      ? new Intl.DateTimeFormat('pt-BR', {
          timeZone: state.settings.timezone || 'America/Manaus',
          dateStyle: 'short',
          timeStyle: 'short',
        }).format(new Date(value))
      : '—';
  function odometer(vehicle: FleetVehicle) {
    const readings = trips
      .filter((t) => t.fleetId === vehicle.id)
      .map((t) => t.odometerIn ?? t.odometerOut);
    return Math.max(vehicle.currentOdometerKm ?? vehicle.initialOdometerKm ?? 0, ...readings);
  }
  function open(next: Editor) {
    setError('');
    setMessage('');
    setEditor(next);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor || busy) return;
    const values = new FormData(event.currentTarget),
      value = (key: string) => String(values.get(key) ?? '').trim();
    let type: string, payload: Record<string, unknown>;
    if (editor.kind === 'vehicle') {
      type = 'FLEET_VEHICLE_SAVE';
      payload = {
        plate: value('plate'),
        name: value('name'),
        initialOdometerKm: Number(value('initialOdometerKm')),
        notes: value('notes'),
      };
    } else if (editor.kind === 'depart') {
      type = 'FLEET_DEPART';
      payload = {
        fleetId: value('fleetId'),
        driver: value('driver'),
        destination: value('destination'),
        purpose: value('purpose'),
        odometerOut: Number(value('odometerOut')),
        conditionOut: value('conditionOut'),
      };
    } else if (editor.kind === 'return') {
      type = 'FLEET_RETURN';
      payload = {
        id: editor.trip.id,
        odometerIn: Number(value('odometerIn')),
        conditionIn: value('conditionIn'),
      };
    } else {
      type = 'MATERIAL_EXIT_CREATE';
      payload = {
        description: value('description'),
        quantity: value('quantity'),
        destination: value('destination'),
        responsible: value('responsible'),
        invoiceNumber: value('invoiceNumber'),
        vehiclePlate: value('vehiclePlate'),
        notes: value('notes'),
      };
    }
    setBusy(true);
    setError('');
    try {
      if ((await run(type, payload)) === false)
        throw Error('Não foi possível salvar. Revise e tente novamente.');
      setMessage(
        editor.kind === 'depart'
          ? 'Saída registrada. Abra Vistorias para anexar fotos ou vídeos.'
          : editor.kind === 'return'
            ? 'Retorno registrado. A vistoria de retorno está disponível no histórico.'
            : 'Registro salvo com sucesso.',
      );
      if (editor.kind === 'return') {
        setTripId(editor.trip.id);
        setPhase('return');
      }
      setEditor(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível salvar o registro.');
    } finally {
      setBusy(false);
    }
  }
  const openTrip = (item: FleetTrip) => {
    setTripId(item.id);
    setPhase(item.status === 'returned' ? 'return' : 'departure');
  };
  return (
    <div className="logistics-panel">
      <div className="logistics-toolbar">
        <label className="logistics-search">
          <Search size={18} aria-hidden="true" />
          <input
            className="input"
            aria-label={
              mode === 'fleet'
                ? 'Buscar placa, veículo, motorista ou destino'
                : 'Buscar material, nota fiscal ou destino'
            }
            placeholder={
              mode === 'fleet'
                ? 'Buscar placa, motorista ou destino…'
                : 'Buscar material, nota fiscal ou destino…'
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <div className="actions">
          {mode === 'fleet' ? (
            <>
              {canSaveVehicle && (
                <Button onClick={() => open({ kind: 'vehicle' })}>
                  <Plus size={16} /> Cadastrar veículo
                </Button>
              )}
              {canDepart && (
                <Button
                  variant="primary"
                  disabled={!available.length}
                  onClick={() => open({ kind: 'depart' })}
                >
                  <LogOut size={16} /> Registrar saída
                </Button>
              )}
            </>
          ) : (
            canMaterial && (
              <Button variant="primary" onClick={() => open({ kind: 'material' })}>
                <Plus size={16} /> Registrar saída de material
              </Button>
            )
          )}
        </div>
      </div>
      {message && (
        <p className="notice success" role="status">
          {message}
        </p>
      )}
      {error && !editor && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {mode === 'fleet' ? (
        <>
          <div className="logistics-kpis">
            <Metric
              icon={<Truck size={20} />}
              label="Veículos da empresa"
              value={vehicles.length}
            />
            <Metric icon={<LogOut size={20} />} label="Em deslocamento" value={out.length} />
            <Metric
              icon={<LogIn size={20} />}
              label="Disponíveis na unidade"
              value={available.length}
            />
            <Metric
              icon={<Gauge size={20} />}
              label="Distância registrada"
              value={km(trips.reduce((sum, t) => sum + (t.distanceKm ?? 0), 0))}
            />
          </div>
          <section className="card">
            <div className="card-header">
              <h2 className="card-title">Frota própria</h2>
              <span className="muted">
                {vehicles.length}{' '}
                {vehicles.length === 1 ? 'veículo cadastrado' : 'veículos cadastrados'}
              </span>
            </div>
            {!shownVehicles.length ? (
              <EmptyState
                icon={Truck}
                title={
                  vehicles.length
                    ? 'Nenhum veículo encontrado'
                    : 'Cadastre o primeiro veículo da empresa'
                }
                text="Controle a quilometragem, o motorista e as condições em cada deslocamento."
              />
            ) : (
              <div className="logistics-vehicles">
                {shownVehicles.map((vehicle) => {
                  const current = out.find((t) => t.fleetId === vehicle.id);
                  return (
                    <article className="logistics-vehicle" key={vehicle.id}>
                      <div className="logistics-vehicle-heading">
                        <span className="logistics-plate">{vehicle.plate}</span>
                        <StatusBadge
                          value={current ? 'pending' : vehicle.active ? 'active' : 'disabled'}
                        >
                          {current
                            ? 'Em deslocamento'
                            : vehicle.active
                              ? 'Na unidade'
                              : 'Desativado'}
                        </StatusBadge>
                      </div>
                      <h3>{vehicle.name || 'Veículo da empresa'}</h3>
                      <p>
                        <Gauge size={16} /> {km(odometer(vehicle))}
                      </p>
                      {current && (
                        <p className="logistics-vehicle-route">
                          {current.driver} · {current.destination}
                        </p>
                      )}
                      <div className="actions">
                        {current ? (
                          <>
                            <Button onClick={() => openTrip(current)}>
                              <Camera size={15} /> Vistoria de saída
                            </Button>
                            {canReturn && (
                              <Button
                                variant="primary"
                                onClick={() => open({ kind: 'return', trip: current })}
                              >
                                <LogIn size={15} /> Registrar retorno
                              </Button>
                            )}
                          </>
                        ) : (
                          canDepart &&
                          vehicle.active && (
                            <Button onClick={() => open({ kind: 'depart', vehicle })}>
                              <LogOut size={15} /> Registrar saída
                            </Button>
                          )
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
          <section className="card">
            <div className="card-header">
              <h2 className="card-title">Histórico de deslocamentos</h2>
              <span className="muted">Saída, retorno e vistorias</span>
            </div>
            {!shownTrips.length ? (
              <EmptyState
                title="Nenhum deslocamento registrado"
                text="As saídas e os retornos dos veículos aparecerão aqui."
              />
            ) : (
              <DataTable>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Veículo / motorista</th>
                      <th>Destino</th>
                      <th>Saída</th>
                      <th>Retorno</th>
                      <th>Quilometragem</th>
                      <th>Situação / ações</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shownTrips.map((item) => (
                      <tr key={item.id}>
                        <td>
                          <strong>{item.plate}</strong>
                          <small>{item.driver}</small>
                        </td>
                        <td>{item.destination}</td>
                        <td>
                          {date(item.departedAt)}
                          <small>{km(item.odometerOut)}</small>
                        </td>
                        <td>
                          {date(item.returnedAt)}
                          <small>{km(item.odometerIn)}</small>
                        </td>
                        <td>
                          {item.distanceKm == null ? 'Aguardando retorno' : km(item.distanceKm)}
                        </td>
                        <td>
                          <div className="actions">
                            <StatusBadge value={item.status === 'out' ? 'pending' : 'completed'}>
                              {item.status === 'out' ? 'Em deslocamento' : 'Retornou'}
                            </StatusBadge>
                            <Button onClick={() => openTrip(item)}>
                              <Camera size={15} /> Vistorias
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </DataTable>
            )}
          </section>
        </>
      ) : (
        <>
          <div className="logistics-kpis logistics-material-kpis">
            <Metric
              icon={<Package size={20} />}
              label="Saídas registradas"
              value={materials.length}
            />
            <Metric
              icon={<FileText size={20} />}
              label="Com nota fiscal informada"
              value={materials.filter((m) => m.invoiceNumber).length}
            />
          </div>
          <section className="card">
            <div className="card-header">
              <h2 className="card-title">Saída de materiais</h2>
              <span className="muted">Conferência documental da portaria</span>
            </div>
            {!shownMaterials.length ? (
              <EmptyState
                icon={Package}
                title={
                  materials.length
                    ? 'Nenhuma saída encontrada'
                    : 'Nenhuma saída de material registrada'
                }
                text="Registre o material, a quantidade, o destino e o número da nota fiscal, quando houver."
              />
            ) : (
              <DataTable>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Data / operador</th>
                      <th>Material / quantidade</th>
                      <th>Nota fiscal</th>
                      <th>Destino / responsável</th>
                      <th>Ações</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shownMaterials.map((item) => (
                      <tr key={item.id}>
                        <td>
                          {date(item.createdAt)}
                          <small>{item.createdBy}</small>
                        </td>
                        <td>
                          <strong>{item.description}</strong>
                          <small>{item.quantity}</small>
                        </td>
                        <td>{item.invoiceNumber || 'Não informada'}</td>
                        <td>
                          {item.destination}
                          <small>{item.responsible}</small>
                        </td>
                        <td>
                          <Button onClick={() => setMaterialId(item.id)}>Ver registro</Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </DataTable>
            )}
          </section>
          <p className="field-hint">
            O número informado é uma referência documental. O sistema não emite nem valida a nota
            fiscal na SEFAZ.
          </p>
        </>
      )}
      {editor && (
        <ModalFrame
          title={
            editor.kind === 'vehicle'
              ? 'Cadastrar veículo da empresa'
              : editor.kind === 'depart'
                ? 'Registrar saída da frota'
                : editor.kind === 'return'
                  ? 'Registrar retorno à empresa'
                  : 'Registrar saída de material'
          }
          onClose={() => {
            if (!busy) setEditor(null);
          }}
          wide
        >
          <form onSubmit={submit}>
            <div className="modal-body logistics-form">
              {editor.kind === 'vehicle' && (
                <>
                  <Field label="Placa" name="plate" required maxLength={15} placeholder="ABC1D23" />
                  <Field
                    label="Descrição do veículo"
                    name="name"
                    required
                    maxLength={150}
                    placeholder="Modelo, cor ou identificação"
                  />
                  <Field
                    label="Quilometragem atual (km)"
                    name="initialOdometerKm"
                    required
                    type="number"
                    min="0"
                    max="999999999"
                    step="1"
                  />
                  <Note label="Observações do veículo" name="notes" />
                </>
              )}
              {editor.kind === 'depart' && (
                <>
                  <FormField label="Veículo da empresa">
                    <select
                      className="input"
                      name="fleetId"
                      required
                      value={editor.vehicle?.id ?? ''}
                      onChange={(e) =>
                        setEditor({
                          kind: 'depart',
                          vehicle: available.find((vehicle) => vehicle.id === e.target.value),
                        })
                      }
                    >
                      <option value="" disabled>
                        Selecione um veículo disponível
                      </option>
                      {available.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.plate} · {v.name} · {km(odometer(v))}
                        </option>
                      ))}
                    </select>
                  </FormField>
                  <Field label="Motorista" name="driver" required maxLength={150} />
                  <Field label="Destino" name="destination" required maxLength={200} />
                  <Field
                    key={editor.vehicle?.id ?? 'no-vehicle'}
                    label="Quilometragem na saída (km)"
                    name="odometerOut"
                    type="number"
                    required
                    min={String(editor.vehicle ? odometer(editor.vehicle) : 0)}
                    step="1"
                    defaultValue={editor.vehicle ? odometer(editor.vehicle) : undefined}
                  />
                  <Field label="Motivo do deslocamento" name="purpose" required maxLength={500} />
                  <Note
                    label="Condições do veículo na saída"
                    name="conditionOut"
                    placeholder="Ex.: sem avarias aparentes; risco no para-choque traseiro."
                  />
                  <p className="field-hint logistics-full">
                    Após registrar, abra a vistoria de saída para anexar fotos e vídeos.
                  </p>
                </>
              )}
              {editor.kind === 'return' && (
                <>
                  <div className="notice info logistics-full">
                    {editor.trip.plate} · {editor.trip.driver} · Saída:{' '}
                    {km(editor.trip.odometerOut)}
                  </div>
                  <Field
                    label="Quilometragem no retorno (km)"
                    name="odometerIn"
                    type="number"
                    required
                    min={String(editor.trip.odometerOut)}
                    step="1"
                  />
                  <Note
                    label="Condições do veículo no retorno"
                    name="conditionIn"
                    placeholder="Registre novas avarias, limpeza ou outras observações."
                  />
                  <p className="field-hint logistics-full">
                    A distância percorrida será calculada automaticamente. As fotos e os vídeos do
                    retorno ficam em uma vistoria separada.
                  </p>
                </>
              )}
              {editor.kind === 'material' && (
                <>
                  <Field label="Material / descrição" name="description" required maxLength={500} />
                  <Field
                    label="Quantidade e unidade"
                    name="quantity"
                    required
                    maxLength={100}
                    placeholder="Ex.: 12 caixas / 250 kg"
                  />
                  <Field
                    label="Número da nota fiscal"
                    name="invoiceNumber"
                    maxLength={100}
                    placeholder="Informe quando houver"
                  />
                  <Field
                    label="Destino / destinatário"
                    name="destination"
                    required
                    maxLength={200}
                  />
                  <Field
                    label="Responsável pela retirada"
                    name="responsible"
                    required
                    maxLength={150}
                  />
                  <Field label="Placa do veículo" name="vehiclePlate" maxLength={15} />
                  <Note label="Observações da saída" name="notes" />
                </>
              )}
              {error && (
                <p className="notice error logistics-full" role="alert">
                  {error}
                </p>
              )}
            </div>
            <div className="modal-footer">
              <Button disabled={busy} onClick={() => setEditor(null)}>
                Cancelar
              </Button>
              <Button type="submit" variant="primary" disabled={busy}>
                {busy
                  ? 'Salvando…'
                  : editor.kind === 'return'
                    ? 'Confirmar retorno'
                    : editor.kind === 'depart'
                      ? 'Confirmar saída'
                      : 'Salvar registro'}
              </Button>
            </div>
          </form>
        </ModalFrame>
      )}
      {trip && !editor && (
        <ModalFrame title={'Vistorias · ' + trip.plate} onClose={() => setTripId(null)} wide>
          <div className="modal-body logistics-detail">
            <div className="logistics-detail-summary">
              <Detail label="Motorista" value={trip.driver} />
              <Detail label="Destino" value={trip.destination} />
              <Detail label="Saída" value={date(trip.departedAt)} />
              <Detail label="Retorno" value={date(trip.returnedAt)} />
              <Detail label="KM na saída" value={km(trip.odometerOut)} />
              <Detail label="KM no retorno" value={km(trip.odometerIn)} />
              <Detail label="Distância" value={km(trip.distanceKm)} />
              <Detail label="Motivo" value={trip.purpose} />
            </div>
            <div className="tabs" role="group" aria-label="Etapa da vistoria">
              <Button
                variant={phase === 'departure' ? 'primary' : 'secondary'}
                aria-pressed={phase === 'departure'}
                onClick={() => setPhase('departure')}
              >
                Vistoria de saída
              </Button>
              <Button
                variant={phase === 'return' ? 'primary' : 'secondary'}
                aria-pressed={phase === 'return'}
                disabled={trip.status !== 'returned'}
                onClick={() => setPhase('return')}
              >
                Vistoria de retorno
              </Button>
            </div>
            <p className="logistics-condition">
              {phase === 'departure'
                ? trip.conditionOut || 'Sem observações de saída.'
                : trip.conditionIn || 'Sem observações de retorno.'}
            </p>
            {capability(user, 'documentView') ? (
              <IncidentMedia
                key={trip.id + phase}
                recordId={trip.id}
                recordCollection="fleetTrips"
                phase={phase}
                userId={user.id}
                canUpload={
                  phase === 'departure'
                    ? canDepart && trip.status === 'out'
                    : canReturn && trip.status === 'returned'
                }
                isAdmin={user.role === 'admin'}
                changed={reload}
              />
            ) : (
              <p className="notice info">Seu perfil não permite visualizar fotos e vídeos.</p>
            )}
            <p className="field-hint">
              Saída registrada por {trip.createdBy}.{' '}
              {trip.returnedAt
                ? 'Retorno registrado por ' + trip.updatedBy + '.'
                : 'Aguardando retorno.'}
            </p>
          </div>
        </ModalFrame>
      )}
      {material && (
        <ModalFrame title="Registro de saída de material" onClose={() => setMaterialId(null)}>
          <div className="modal-body logistics-detail-summary">
            <Detail label="Material" value={material.description} />
            <Detail label="Quantidade" value={material.quantity} />
            <Detail
              label="Número da nota fiscal"
              value={material.invoiceNumber || 'Não informada'}
            />
            <Detail label="Destino" value={material.destination} />
            <Detail label="Responsável pela retirada" value={material.responsible} />
            <Detail label="Veículo" value={material.vehiclePlate || 'Não informado'} />
            <Detail label="Registrado em" value={date(material.createdAt)} />
            <Detail label="Operador" value={material.createdBy} />
            <Detail label="Observações" value={material.notes || 'Sem observações.'} />
          </div>
        </ModalFrame>
      )}
    </div>
  );
}
function Field({
  label,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <FormField label={label}>
      <input className="input" {...props} />
    </FormField>
  );
}
function Note({
  label,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string }) {
  return (
    <div className="logistics-full">
      <FormField label={label}>
        <textarea className="input" maxLength={2000} rows={3} {...props} />
      </FormField>
    </div>
  );
}
function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: ReactNode }) {
  return (
    <div className="logistics-metric">
      <span>{icon}</span>
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
      </div>
    </div>
  );
}
function Detail({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="logistics-detail-item">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
